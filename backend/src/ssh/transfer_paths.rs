use super::*;

pub(super) fn remote_transfer_paths(
    target: &str,
    task_id: &str,
) -> Result<(String, String), String> {
    let (raw_parent, _) = target
        .rsplit_once('/')
        .ok_or("Remote upload path has no parent")?;
    let raw_parent = if raw_parent.is_empty() {
        "/"
    } else {
        raw_parent
    };
    // Segment-level `..` convergence (same shape as `normalize_remote_path`):
    // the `.part`/`.backup` staging files must land in the *resolved* target
    // directory, or the same-directory atomic rename premise breaks for
    // traversal-shaped targets (`/data/a/../f.bin` must stage in `/data/`,
    // not `/data/a/../`). A `..` arriving at the root is dropped, never
    // escaped; a relative parent that collapses entirely has no anchor left
    // and is rejected like a bare name (relative staging would depend on the
    // remote CWD).
    let absolute = raw_parent.starts_with('/');
    let mut segments: Vec<&str> = Vec::new();
    for segment in raw_parent.split('/') {
        if segment == ".." {
            // Only a real name segment can be popped; the leading "" of an
            // absolute path is the root marker and `..` there is discarded.
            let poppable = !(segments.len() == 1 && segments[0].is_empty());
            if poppable {
                segments.pop();
            }
        } else {
            segments.push(segment);
        }
    }
    if !absolute && segments.is_empty() {
        return Err("Remote upload path has no parent".to_string());
    }
    let joined = segments.join("/");
    let parent: &str = if joined.is_empty() { "/" } else { &joined };
    Ok((
        format!(
            "{}/.dbx-upload-{task_id}.part",
            parent.trim_end_matches('/')
        ),
        format!(
            "{}/.dbx-upload-{task_id}.backup",
            parent.trim_end_matches('/')
        ),
    ))
}

/// Permission attributes carried over from an existing target to the staged
/// replacement file: the mode's permission bits (`0o7777`, so an executable
/// script keeps its `+x` across saves) and nothing else. Ownership (uid/gid)
/// is deliberately not preserved — SETSTAT on uid/gid needs elevated
/// privileges, so the replacement keeps the writing user's own ownership.
pub(super) fn preserved_target_permissions(
    target: &russh_sftp::protocol::FileAttributes,
) -> Option<russh_sftp::protocol::FileAttributes> {
    let permissions = target.permissions?;
    Some(russh_sftp::protocol::FileAttributes {
        permissions: Some(permissions & 0o7777),
        ..Default::default()
    })
}

/// Applies [`preserved_target_permissions`] to the staged file before the
/// rename. A SETSTAT failure aborts the commit with the original target
/// untouched instead of silently saving a permission-downgraded copy (issue
/// #37: an executable script must not lose its `+x` on every save).
pub(crate) async fn apply_preserved_permissions(
    sftp: &Arc<AsyncMutex<SftpSession>>,
    temporary: &str,
    target: Option<&russh_sftp::protocol::FileAttributes>,
) -> Result<(), String> {
    if let Some(attributes) = target.and_then(preserved_target_permissions) {
        let mode = attributes.permissions.unwrap_or_default();
        if let Err(error) = sftp
            .lock()
            .await
            .set_metadata(temporary.to_string(), attributes)
            .await
        {
            let _ = sftp.lock().await.remove_file(temporary.to_string()).await;
            return Err(format!(
                "SFTP save failed while preserving permissions {}: {error}; original file left unchanged",
                format_permissions(mode),
            ));
        }
    }
    Ok(())
}

/// Round-trip decisions of the commit sequence, derived from the target's
/// attributes alone (pure; unit-tested without a session).
pub(super) struct CommitPlan {
    /// The target exists, so it has to be renamed aside before the staged file
    /// can take its place.
    pub(super) backup_rename: bool,
    /// SETSTAT payload for the staged file. `None` means the server declared no
    /// permission bits, so no SETSTAT is sent at all (issue #37 only asks for
    /// the mode to survive; there is nothing to preserve without one).
    pub(super) permissions: Option<russh_sftp::protocol::FileAttributes>,
}

pub(super) fn commit_plan(target: Option<&russh_sftp::protocol::FileAttributes>) -> CommitPlan {
    CommitPlan {
        backup_rename: target.is_some(),
        permissions: target.and_then(preserved_target_permissions),
    }
}

/// Renames a finished staging file onto its target, moving an existing target
/// aside first and restoring it when the commit fails.
///
/// Every call here is one SFTP round trip and the count is multiplied by the
/// file count, so the sequence is kept to the minimum that still preserves the
/// rollback contract: an overwrite used to cost five round trips per file
/// (STAT + SETSTAT + RENAME + RENAME + REMOVE) against two for a fresh upload
/// — hundreds of small files on a 100–200 ms public-cloud link is exactly the
/// "first upload under a minute, overwrite ten-plus minutes" gap of issue
/// #284. It now costs three (STAT + pipelined SETSTAT/RENAME + RENAME, with
/// the backup REMOVE no longer awaited).
pub(super) async fn commit_remote_file(
    sftp: &Arc<AsyncMutex<SftpSession>>,
    temporary: &str,
    target: &str,
    backup: &str,
) -> Result<(), String> {
    // One guard covers the whole sequence: re-locking per call would not save a
    // round trip, and holding it for the sequence keeps the commit ordered
    // against other operations sharing the session.
    let session = sftp.lock().await;
    let target_attributes = session.metadata(target.to_string()).await.ok();
    let CommitPlan {
        backup_rename,
        permissions,
    } = commit_plan(target_attributes.as_ref());
    if backup_rename {
        // SETSTAT hits the staging file while the RENAME moves the current
        // target aside: different paths, no ordering dependency, so both go out
        // as one pipelined batch (russh-sftp multiplexes requests by id)
        // instead of paying a round trip each. Compensations match the serial
        // version: a SETSTAT failure keeps the original in place (restore the
        // backup, drop the staging file), a RENAME failure is reported as-is
        // and leaves the staging file to the caller's cleanup.
        let (preset, moved) = tokio::join!(
            async {
                match permissions {
                    Some(attributes) => {
                        let mode = attributes.permissions.unwrap_or_default();
                        session
                            .set_metadata(temporary.to_string(), attributes)
                            .await
                            .map_err(|error| {
                                format!(
                                    "SFTP save failed while preserving permissions {}: {error}; original file left unchanged",
                                    format_permissions(mode),
                                )
                            })
                    }
                    None => Ok(()),
                }
            },
            session.rename(target.to_string(), backup.to_string()),
        );
        if let Err(error) = preset {
            if moved.is_ok() {
                let _ = session.rename(backup.to_string(), target.to_string()).await;
            }
            let _ = session.remove_file(temporary.to_string()).await;
            return Err(error);
        }
        moved.map_err(sftp_error)?;
    }
    if let Err(error) = session
        .rename(temporary.to_string(), target.to_string())
        .await
    {
        if backup_rename {
            let _ = session.rename(backup.to_string(), target.to_string()).await;
        }
        let _ = session.remove_file(temporary.to_string()).await;
        return Err(sftp_error(error));
    }
    if !backup_rename {
        return Ok(());
    }
    drop(session);
    // The backup is dead weight once the target is in place, and awaiting its
    // REMOVE made every overwritten file pay one more round trip. A failed
    // cleanup only leaves an orphan `.dbx-upload-<task>.backup` beside the
    // target; each upload names its own task id, so a later upload never trips
    // over it.
    let cleanup = Arc::clone(sftp);
    let backup = backup.to_string();
    tokio::spawn(async move {
        let _ = cleanup.lock().await.remove_file(backup).await;
    });
    Ok(())
}
