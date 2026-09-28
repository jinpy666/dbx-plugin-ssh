// 由 scripts/sync_fig_specs.mjs 生成（withfig/autocomplete @ aef52acff84c45edde61ae610cc2c964802b9a38）——纯数据，勿手改。
// 归一化形态见 src/lib/completion/fig/types.ts；重生成：pnpm fig:sync
import type { FigSpecRoot } from "../../../src/lib/completion/fig/types";

export const spec: FigSpecRoot = {
  "name": "git",
  "description": "Distributed version control system",
  "subcommands": [
    {
      "name": "archive",
      "description": "Create an archive of files from a named tree",
      "options": [
        {
          "names": [
            "--format"
          ],
          "description": "Archive format",
          "args": {
            "name": "fmt",
            "suggestions": [
              "tar",
              "zip"
            ]
          }
        },
        {
          "names": [
            "--prefix"
          ],
          "description": "Prepend prefix to each pathname in the archive",
          "args": {
            "name": "prefix"
          }
        },
        {
          "names": [
            "--add-file"
          ],
          "description": "Add untracked file to archive",
          "args": {
            "name": "file"
          }
        },
        {
          "names": [
            "-o",
            "--output"
          ],
          "description": "Write the archive to this file",
          "args": {
            "name": "file"
          }
        },
        {
          "names": [
            "--worktree-attributes"
          ],
          "description": "Read .gitattributes in working directory"
        },
        {
          "names": [
            "-v",
            "--verbose"
          ],
          "description": "Report archived files on stderr"
        },
        {
          "names": [
            "-NUM"
          ],
          "description": "Set compression level"
        },
        {
          "names": [
            "-l",
            "--list"
          ],
          "description": "List supported archive formats"
        },
        {
          "names": [
            "--remote"
          ],
          "description": "Retrieve the archive from remote repository <repo>",
          "args": {
            "name": "repo"
          }
        },
        {
          "names": [
            "--exec"
          ],
          "description": "Path to the remote git-upload-archive command",
          "args": {
            "name": "command"
          }
        }
      ],
      "args": [
        {
          "name": "tree-ish",
          "generators": [
            {
              "kind": "script",
              "script": [
                "git",
                "--no-optional-locks",
                "diff",
                "--cached",
                "--name-only"
              ]
            }
          ]
        },
        {
          "name": "path",
          "isVariadic": true,
          "isOptional": true
        }
      ]
    },
    {
      "name": "blame",
      "options": [
        {
          "names": [
            "--incremental"
          ],
          "description": "Show blame entries as we find them, incrementally"
        },
        {
          "names": [
            "-b"
          ],
          "description": "Do not show object names of boundary commits (Default: off)"
        },
        {
          "names": [
            "--root"
          ],
          "description": "Do not treat root commits as boundaries (Default: off)"
        },
        {
          "names": [
            "--show-stats"
          ],
          "description": "Show work cost statistics"
        },
        {
          "names": [
            "--progress"
          ],
          "description": "Force progress reporting"
        },
        {
          "names": [
            "--score-debug"
          ],
          "description": "Show output score for blame entries"
        },
        {
          "names": [
            "-f",
            "--show-name"
          ],
          "description": "Show original filename (Default: auto)"
        },
        {
          "names": [
            "-n",
            "--show-number"
          ],
          "description": "Show original linenumber (Default: off)"
        },
        {
          "names": [
            "-p",
            "--porcelain"
          ],
          "description": "Show in a format designed for machine consumption"
        },
        {
          "names": [
            "--line-porcelain"
          ],
          "description": "Show porcelain format with per-line commit information"
        },
        {
          "names": [
            "-c"
          ],
          "description": "Use the same output mode as git-annotate (Default: off)"
        },
        {
          "names": [
            "-t"
          ],
          "description": "Show raw timestamp (Default: off)"
        },
        {
          "names": [
            "-l"
          ],
          "description": "Show long commit SHA1 (Default: off)"
        },
        {
          "names": [
            "-s"
          ],
          "description": "Suppress author name and timestamp (Default: off)"
        },
        {
          "names": [
            "-e",
            "--show-email"
          ],
          "description": "Show author email instead of name (Default: off)"
        },
        {
          "names": [
            "-w"
          ],
          "description": "Ignore whitespace differences"
        },
        {
          "names": [
            "--ignore-rev"
          ],
          "description": "Ignore <rev> when blaming",
          "args": {
            "name": "rev",
            "generators": [
              {
                "kind": "script",
                "script": [
                  "git",
                  "rev-list",
                  "--all",
                  "--oneline"
                ]
              }
            ]
          }
        },
        {
          "names": [
            "--ignore-revs-file"
          ],
          "description": "Ignore revisions from <file>",
          "args": {
            "name": "file"
          }
        },
        {
          "names": [
            "--color-lines"
          ],
          "description": "Color redundant metadata from previous line differently"
        },
        {
          "names": [
            "--color-by-age"
          ],
          "description": "Color lines by age"
        },
        {
          "names": [
            "--minimal"
          ],
          "description": "Spend extra cycles to find better match"
        },
        {
          "names": [
            "-S"
          ],
          "description": "Use revisions from <file> instead of calling git-rev-list",
          "args": {
            "name": "file"
          }
        },
        {
          "names": [
            "--contents"
          ],
          "description": "Use <file>'s contents as the final image",
          "args": {
            "name": "file"
          }
        },
        {
          "names": [
            "-C"
          ],
          "description": "Find line copies within and across files"
        },
        {
          "names": [
            "-M"
          ],
          "description": "Find line movements within and across files"
        },
        {
          "names": [
            "-L"
          ],
          "description": "Process only line range <start>,<end> or function :<funcname>",
          "args": {
            "name": "start,end"
          }
        },
        {
          "names": [
            "--abbrev"
          ],
          "description": "Use <n> digits to display object names",
          "args": {
            "name": "n",
            "isOptional": true
          }
        }
      ],
      "args": [
        {
          "name": "file"
        }
      ]
    },
    {
      "name": "commit",
      "description": "Record changes to the repository",
      "options": [
        {
          "names": [
            "-m",
            "--message"
          ],
          "description": "Use the given message as the commit message",
          "args": {
            "name": "message"
          }
        },
        {
          "names": [
            "-a",
            "--all"
          ],
          "description": "Stage all modified and deleted paths"
        },
        {
          "names": [
            "-am"
          ],
          "description": "Stage all and use given text as commit message",
          "args": {
            "name": "message"
          }
        },
        {
          "names": [
            "-v",
            "--verbose"
          ],
          "description": "Show unified diff of all file changes"
        },
        {
          "names": [
            "-p",
            "--patch"
          ],
          "description": "Use the interactive patch selection interface to chose which changes to commi"
        },
        {
          "names": [
            "-C",
            "--reuse-message"
          ],
          "description": "Take an existing commit object, and reuse the log message and the authorship",
          "args": {
            "name": "commit",
            "generators": [
              {
                "kind": "script",
                "script": [
                  "git",
                  "--no-optional-locks",
                  "log",
                  "--oneline"
                ]
              }
            ]
          }
        },
        {
          "names": [
            "-c",
            "--reedit-message"
          ],
          "description": "Like -C, but with -c the editor is invoked, so that the user can further edit",
          "args": {
            "name": "commit",
            "generators": [
              {
                "kind": "script",
                "script": [
                  "git",
                  "--no-optional-locks",
                  "log",
                  "--oneline"
                ]
              }
            ]
          }
        },
        {
          "names": [
            "--fixup"
          ],
          "description": "Construct a commit message for use with rebase --autosquash. The commit messa",
          "args": {
            "name": "commit",
            "generators": [
              {
                "kind": "script",
                "script": [
                  "git",
                  "--no-optional-locks",
                  "log",
                  "--oneline"
                ]
              }
            ]
          }
        },
        {
          "names": [
            "--squash"
          ],
          "description": "Construct a commit message for use with rebase --autosquash. The commit messa",
          "args": {
            "name": "commit",
            "generators": [
              {
                "kind": "script",
                "script": [
                  "git",
                  "--no-optional-locks",
                  "log",
                  "--oneline"
                ]
              }
            ]
          }
        },
        {
          "names": [
            "--reset-author"
          ],
          "description": "When used with -C/-c/--amend options, or when committing after a conflicting"
        },
        {
          "names": [
            "--short"
          ],
          "description": "When doing a dry-run, give the output in the short-format. See git-status[1]"
        },
        {
          "names": [
            "--branch"
          ],
          "description": "Show the branch and tracking info even in short-format"
        },
        {
          "names": [
            "--porcelain"
          ],
          "description": "When doing a dry-run, give the output in a porcelain-ready format. See git-st"
        },
        {
          "names": [
            "--long"
          ],
          "description": "When doing a dry-run, give the output in the long-format. Implies --dry-run"
        },
        {
          "names": [
            "-z",
            "--null"
          ],
          "description": "When showing short or porcelain status output, print the filename verbatim an"
        },
        {
          "names": [
            "-F",
            "--file"
          ],
          "description": "Take the commit message from the given file. Use - to read the message from t",
          "args": {
            "name": "file"
          }
        },
        {
          "names": [
            "--author"
          ],
          "description": "Override the commit author. Specify an explicit author using the standard A U",
          "args": {
            "name": "author"
          }
        },
        {
          "names": [
            "--date"
          ],
          "description": "Override the author date used in the commit",
          "args": {
            "name": "date"
          }
        },
        {
          "names": [
            "-t",
            "--template"
          ],
          "description": "When editing the commit message, start the editor with the contents in the gi",
          "args": {
            "name": "file"
          }
        },
        {
          "names": [
            "-s",
            "--signoff"
          ],
          "description": "Add a Signed-off-by trailer by the committer at the end of the commit log mes"
        },
        {
          "names": [
            "--no-signoff"
          ],
          "description": "Don't add a Signed-off-by trailer by the committer at the end of the commit l"
        },
        {
          "names": [
            "-n",
            "--no-verify"
          ],
          "description": "This option bypasses the pre-commit and commit-msg hooks. See also githooks[5]"
        },
        {
          "names": [
            "--allow-empty"
          ],
          "description": "Usually recording a commit that has the exact same tree as its sole parent co"
        },
        {
          "names": [
            "--allow-empty-message"
          ],
          "description": "Like --allow-empty this command is primarily for use by foreign SCM interface"
        },
        {
          "names": [
            "--cleanup"
          ],
          "description": "This option determines how the supplied commit message should be cleaned up b",
          "args": {
            "name": "mode",
            "description": "Determines how the supplied commit messaged should be cleaned up before committing",
            "suggestions": [
              "strip",
              "whitespace",
              "verbatim",
              "scissors",
              "default"
            ]
          }
        },
        {
          "names": [
            "-e",
            "--edit"
          ],
          "description": "The message taken from file with -F, command line with -m, and from commit ob"
        },
        {
          "names": [
            "--no-edit"
          ],
          "description": "Use the selected commit message without launching an editor. For example, git"
        },
        {
          "names": [
            "--amend"
          ],
          "description": "Replace the tip of the current branch by creating a new commit. The recorded"
        },
        {
          "names": [
            "--no-post-rewrite"
          ],
          "description": "Bypass the post-rewrite hook"
        },
        {
          "names": [
            "-i",
            "--include"
          ],
          "description": "Before making a commit out of staged contents so far, stage the contents of p"
        },
        {
          "names": [
            "-o",
            "--only"
          ],
          "description": "Make a commit by taking the updated working tree contents of the paths specif"
        },
        {
          "names": [
            "--pathspec-from-file"
          ],
          "description": "Pathspec is passed in instead of commandline args. If is exactly - then stand",
          "args": {
            "name": "file"
          }
        },
        {
          "names": [
            "--pathspec-file-nul"
          ],
          "description": "Only meaningful with --pathspec-from-file. Pathspec elements are separated wi"
        },
        {
          "names": [
            "-u",
            "--untracked-files"
          ],
          "description": "Show untracked files. The mode parameter is optional (defaults to all), and i",
          "args": {
            "name": "mode",
            "isOptional": true,
            "suggestions": [
              "no",
              "normal",
              "all"
            ]
          }
        },
        {
          "names": [
            "-q",
            "--quiet"
          ],
          "description": "Suppress commit summary message"
        },
        {
          "names": [
            "--dry-run"
          ],
          "description": "Do not create a commit, but show a list of paths that are to be committed, pa"
        },
        {
          "names": [
            "--status"
          ],
          "description": "Include the output of git-status[1] in the commit message template when using"
        },
        {
          "names": [
            "--no-status"
          ],
          "description": "Do not include the output of git-status[1] in the commit message template whe"
        },
        {
          "names": [
            "-S",
            "--gpg-sign"
          ],
          "description": "GPG-sign commits. The keyid argument is optional and defaults to the committe",
          "args": {
            "name": "keyid",
            "isOptional": true
          }
        },
        {
          "names": [
            "--no-gpg-sign"
          ],
          "description": "Dont GPG-sign commits"
        },
        {
          "names": [
            "--"
          ],
          "description": "Do not interpret any more arguments as options"
        }
      ],
      "args": [
        {
          "name": "pathspec",
          "isVariadic": true,
          "isOptional": true
        }
      ]
    },
    {
      "name": "config",
      "description": "Change Git configuration",
      "options": [
        {
          "names": [
            "--local"
          ],
          "description": "Default: write to the repository .git/config file",
          "args": {
            "isVariadic": true,
            "suggestions": [
              "user.name",
              "user.email"
            ]
          }
        },
        {
          "names": [
            "--global"
          ],
          "description": "For writing options: write to global ~/.gitconfig file rather than the repository .git/config"
        },
        {
          "names": [
            "--replace-all"
          ],
          "description": "Default behavior is to replace at most one line. This replaces all lines matc"
        },
        {
          "names": [
            "--add"
          ],
          "description": "Adds a new line to the option without altering any existing values. This is t"
        },
        {
          "names": [
            "--get"
          ],
          "description": "Get the value for a given key (optionally filtered by a regex matching the va"
        },
        {
          "names": [
            "--get-all"
          ],
          "description": "Like get, but returns all values for a multi-valued key"
        },
        {
          "names": [
            "--get-regexp"
          ],
          "description": "Like --get-all, but interprets the name as a regular expression and writes ou",
          "args": {
            "name": "regexp"
          }
        },
        {
          "names": [
            "--get-urlmatch"
          ],
          "description": "When given a two-part name section.key, the value for section..key whose part",
          "args": {
            "name": "name"
          }
        },
        {
          "names": [
            "--system"
          ],
          "description": "For writing options: write to system-wide $(prefix)/etc/gitconfig rather than"
        },
        {
          "names": [
            "--worktree"
          ],
          "description": "Similar to --local except that.git/config.worktree is read from or written to"
        },
        {
          "names": [
            "-f",
            "--file"
          ],
          "description": "Use the given config file instead of the one specified by GIT_CONFIG",
          "args": {
            "name": "config-file"
          }
        },
        {
          "names": [
            "--blob"
          ],
          "description": "Similar to --file but use the given blob instead of a file. E.g. you can use",
          "args": {
            "name": "blob"
          }
        },
        {
          "names": [
            "--remove-section"
          ],
          "description": "Remove the given section from the configuration file"
        },
        {
          "names": [
            "--rename-section"
          ],
          "description": "Rename the given section to a new name"
        },
        {
          "names": [
            "--unset"
          ],
          "description": "Remove the line matching the key from config file"
        },
        {
          "names": [
            "--unset-all"
          ],
          "description": "Remove all lines matching the key from config file"
        },
        {
          "names": [
            "-l",
            "--list"
          ],
          "description": "List all variables set in config file, along with their values"
        },
        {
          "names": [
            "--fixed-value"
          ],
          "description": "When used with the value-pattern argument, treat value-pattern as an exact st"
        },
        {
          "names": [
            "--type"
          ],
          "description": "Git config will ensure that any input or output is valid under the given type",
          "args": {
            "name": "type",
            "suggestions": [
              "bool",
              "int",
              "bool-or-int",
              "path",
              "expiry-date",
              "color"
            ]
          }
        },
        {
          "names": [
            "--no-type"
          ],
          "description": "Un-sets the previously set type specifier (if one was previously set). This o"
        },
        {
          "names": [
            "-z",
            "--null"
          ],
          "description": "For all options that output values and/or keys, always end values with the nu"
        },
        {
          "names": [
            "--name-only"
          ],
          "description": "Output only the names of config variables for --list or --get-regexp"
        },
        {
          "names": [
            "--show-origin"
          ],
          "description": "Augment the output of all queried config options with the origin type (file"
        },
        {
          "names": [
            "--show-scope"
          ],
          "description": "Similar to --show-origin in that it augments the output of all queried config"
        },
        {
          "names": [
            "--get-colorbool"
          ],
          "description": "Find the color setting for name (e.g. color.diff) and output \"true\" or \"false",
          "args": {
            "name": "name"
          }
        },
        {
          "names": [
            "--get-color"
          ],
          "description": "Find the color configured for name (e.g. color.diff.new) and output it as the",
          "args": {
            "name": "name"
          }
        },
        {
          "names": [
            "-e",
            "--edit"
          ],
          "description": "Opens an editor to modify the specified config file; either --system, --globa"
        },
        {
          "names": [
            "--includes"
          ],
          "description": "Respect include.* directives in config files when looking up values. Defaults"
        },
        {
          "names": [
            "--no-includes"
          ],
          "description": "Respect include.* directives in config files when looking up values. Defaults"
        },
        {
          "names": [
            "--default"
          ],
          "description": "When using --get, and the requested variable is not found, behave as if were",
          "args": {
            "name": "value",
            "isOptional": true
          }
        }
      ],
      "args": [
        {
          "name": "setting",
          "suggestions": [
            "add.ignore-errors",
            "add.interactive.useBuiltin",
            "advice.addEmbeddedRepo",
            "advice.addEmptyPathspec",
            "advice.addIgnoredFile",
            "advice.ambiguousFetchRefspec",
            "advice.amWorkDir",
            "advice.checkoutAmbiguousRemoteBranchName",
            "advice.commitBeforeMerge",
            "advice.detachedHead",
            "advice.fetchShowForcedUpdates",
            "advice.ignoredHook",
            "advice.implicitIdentity",
            "advice.nestedTag",
            "advice.pushAlreadyExists",
            "advice.pushFetchFirst",
            "advice.pushNeedsForce",
            "advice.pushNonFFCurrent",
            "advice.pushNonFFMatching",
            "advice.pushRefNeedsUpdate",
            "advice.pushUnqualifiedRefname",
            "advice.pushUpdateRejected",
            "advice.resetNoRefresh",
            "advice.resolveConflict",
            "advice.rmHints",
            "advice.sequencerInUse",
            "advice.skippedCherryPicks",
            "advice.statusAheadBehind",
            "advice.statusHints",
            "advice.statusUoption",
            "advice.submoduleAlternateErrorStrategyDie",
            "advice.submodulesNotUpdated",
            "advice.suggestDetachingHead",
            "advice.updateSparsePath",
            "advice.waitingForEditor",
            "alias.*",
            "am.keepcr",
            "am.threeWay",
            "apply.ignoreWhitespace",
            "apply.whitespace",
            "blame.blankBoundary",
            "blame.coloring",
            "blame.date",
            "blame.ignoreRevsFile",
            "blame.markIgnoredLines",
            "blame.markUnblamableLines",
            "blame.showEmail",
            "blame.showRoot",
            "branch.<name>.description",
            "branch.<name>.merge",
            "branch.<name>.mergeOptions",
            "branch.<name>.pushRemote",
            "branch.<name>.rebase",
            "branch.<name>.remote",
            "branch.autoSetupMerge",
            "branch.autoSetupRebase",
            "branch.sort",
            "browser.<tool>.cmd",
            "browser.<tool>.path",
            "checkout.defaultRemote",
            "checkout.guess",
            "checkout.thresholdForParallelism",
            "checkout.workers",
            "clean.requireForce",
            "clone.defaultRemoteName",
            "clone.filterSubmodules",
            "clone.rejectShallow",
            "color.advice",
            "color.advice.hint",
            "color.blame.highlightRecent",
            "color.blame.repeatedLines",
            "color.branch",
            "color.branch.<slot>",
            "color.decorate.<slot>",
            "color.diff",
            "color.diff.<slot>",
            "color.grep",
            "color.grep.<slot>",
            "color.interactive",
            "color.interactive.<slot>",
            "color.pager",
            "color.push",
            "color.push.error",
            "color.remote",
            "color.remote.<slot>",
            "color.showBranch",
            "color.status",
            "color.status.<slot>",
            "color.transport",
            "color.transport.rejected",
            "color.ui",
            "column.branch",
            "column.clean",
            "column.status",
            "column.tag",
            "column.ui",
            "commit.cleanup",
            "commit.status",
            "commit.template",
            "commit.verbose",
            "commitGraph.generationVersion",
            "commitGraph.maxNewFilters",
            "commitGraph.readChangedPaths",
            "committer.email",
            "completion.commands",
            "core.abbrev",
            "core.alternateRefsCommand",
            "core.alternateRefsPrefixes",
            "core.askPass",
            "core.attributesFile",
            "core.autocrlf",
            "core.bare",
            "core.bigFileThreshold",
            "core.checkRoundtripEncoding",
            "core.checkStat",
            "core.commentChar",
            "core.commitGraph",
            "core.compression",
            "core.createObject",
            "core.deltaBaseCacheLimit",
            "core.editor",
            "core.eol",
            "core.excludesFile",
            "core.fileMode",
            "core.filesRefLockTimeout",
            "core.fsmonitor",
            "core.fsmonitorHookVersion",
            "core.fsync",
            "core.fsyncMethod",
            "core.fsyncObjectFiles",
            "core.gitProxy",
            "core.hideDotFiles",
            "core.hooksPath",
            "core.ignoreCase",
            "core.ignoreStat",
            "core.logAllRefUpdates",
            "core.looseCompression",
            "core.multiPackIndex",
            "core.notesRef",
            "core.packedGitLimit",
            "core.packedGitWindowSize",
            "core.packedRefsTimeout",
            "core.pager",
            "core.precomposeUnicode",
            "core.preferSymlinkRefs",
            "core.preloadIndex",
            "core.protectHFS",
            "core.protectNTFS",
            "core.quotePath",
            "core.repositoryFormatVersion",
            "core.restrictinheritedhandles",
            "core.safecrlf",
            "core.sharedRepository",
            "core.sparseCheckout",
            "core.sparseCheckoutCone",
            "core.splitIndex",
            "core.sshCommand",
            "core.symlinks",
            "core.trustctime",
            "core.unsetenvvars",
            "core.untrackedCache",
            "core.useReplaceRefs",
            "core.warnAmbiguousRefs",
            "core.whitespace",
            "core.worktree",
            "credential.helper",
            "credential.useHttpPath",
            "credential.username",
            "credentialCache.ignoreSIGHUP",
            "credentialStore.lockTimeoutMS",
            "credential.<url>.helper",
            "credential.<url>.useHttpPath",
            "credential.<url>.username",
            "credentialCache.<url>.ignoreSIGHUP",
            "credentialStore.<url>.lockTimeoutMS",
            "diff.<driver>.binary",
            "diff.<driver>.cachetextconv",
            "diff.<driver>.command",
            "diff.<driver>.textconv",
            "diff.<driver>.wordRegex",
            "diff.<driver>.xfuncname",
            "diff.algorithm",
            "diff.autoRefreshIndex",
            "diff.colorMoved",
            "diff.colorMovedWS",
            "diff.context",
            "diff.dirstat",
            "diff.external",
            "diff.guitool",
            "diff.ignoreSubmodules",
            "diff.indentHeuristic",
            "diff.interHunkContext",
            "diff.mnemonicPrefix",
            "diff.noprefix",
            "diff.orderFile",
            "diff.relative",
            "diff.renameLimit",
            "diff.renames",
            "diff.statGraphWidth",
            "diff.submodule",
            "diff.suppressBlankEmpty",
            "diff.tool",
            "diff.wordRegex",
            "diff.wsErrorHighlight",
            "difftool.<tool>.cmd",
            "difftool.<tool>.path",
            "difftool.prompt",
            "extensions.objectFormat",
            "extensions.worktreeConfig",
            "fastimport.unpackLimit",
            "feature.*",
            "feature.experimental",
            "feature.manyFiles",
            "fetch.fsck.<msg-id>",
            "fetch.fsck.skipList",
            "fetch.fsckObjects",
            "fetch.negotiationAlgorithm",
            "fetch.output",
            "fetch.parallel",
            "fetch.prune",
            "fetch.pruneTags",
            "fetch.recurseSubmodules",
            "fetch.showForcedUpdates",
            "fetch.unpackLimit",
            "fetch.writeCommitGraph",
            "filter.<driver>.clean",
            "filter.<driver>.smudge",
            "format.attach",
            "format.cc",
            "format.coverFromDescription",
            "format.coverLetter",
            "format.encodeEmailHeaders",
            "format.filenameMaxLength",
            "format.from",
            "format.headers",
            "format.notes",
            "format.numbered",
            "format.outputDirectory",
            "format.pretty",
            "format.signature",
            "format.signatureFile",
            "format.signOff",
            "format.subjectPrefix",
            "format.suffix",
            "format.thread",
            "format.useAutoBase",
            "fsck.<msg-id>",
            "fsck.skipList",
            "gc.<pattern>.reflogExpire",
            "gc.<pattern>.reflogExpireUnreachable",
            "gc.aggressiveDepth",
            "gc.aggressiveWindow",
            "gc.auto",
            "gc.autoDetach",
            "gc.autoPackLimit",
            "gc.bigPackThreshold",
            "gc.cruftPacks",
            "gc.logExpiry",
            "gc.packRefs",
            "gc.pruneExpire",
            "gc.rerereResolved",
            "gc.rerereUnresolved",
            "gc.worktreePruneExpire",
            "gc.writeCommitGraph",
            "gitcvs.allBinary",
            "gitcvs.commitMsgAnnotation",
            "gitcvs.dbDriver",
            "gitcvs.dbName",
            "gitcvs.dbTableNamePrefix",
            "gitcvs.dbUser",
            "gitcvs.enabled",
            "gitcvs.logFile",
            "gitcvs.usecrlfattr",
            "gitweb.snapshot",
            "gitweb.url",
            "gpg.<format>.program",
            "gpg.format",
            "gpg.minTrustLevel",
            "gpg.program",
            "gpg.ssh.allowedSignersFile",
            "gpg.ssh.defaultKeyCommand",
            "gpg.ssh.revocationFile",
            "grep.column",
            "grep.extendedRegexp",
            "grep.fallbackToNoIndex",
            "grep.lineNumber",
            "grep.patternType",
            "grep.threads",
            "gui.blamehistoryctx",
            "gui.commitMsgWidth",
            "gui.copyBlameThreshold",
            "gui.diffContext",
            "gui.displayUntracked",
            "gui.encoding",
            "gui.fastCopyBlame",
            "gui.matchTrackingBranch",
            "gui.newBranchTemplate",
            "gui.pruneDuringFetch",
            "gui.spellingDictionary",
            "gui.trustmtime",
            "guitool.<name>.argPrompt",
            "guitool.<name>.cmd",
            "guitool.<name>.confirm",
            "guitool.<name>.needsFile",
            "guitool.<name>.noConsole",
            "guitool.<name>.noRescan",
            "guitool.<name>.prompt",
            "guitool.<name>.revPrompt",
            "guitool.<name>.revUnmerged",
            "guitool.<name>.title",
            "help.autoCorrect",
            "help.browser",
            "help.format",
            "help.htmlPath",
            "http.cookieFile",
            "http.curloptResolve",
            "http.delegation",
            "http.emptyAuth",
            "http.extraHeader",
            "http.followRedirects",
            "http.lowSpeedLimit",
            "http.maxRequests",
            "http.minSessions",
            "http.noEPSV",
            "http.pinnedPubkey",
            "http.postBuffer",
            "http.proxy",
            "http.proxyAuthMethod",
            "http.proxySSLCAInfo",
            "http.proxySSLCert",
            "http.proxySSLCertPasswordProtected",
            "http.proxySSLKey",
            "http.saveCookies",
            "http.schannelCheckRevoke",
            "http.schannelUseSSLCAInfo",
            "http.sslBackend",
            "http.sslCAInfo",
            "http.sslCAPath",
            "http.sslCert",
            "http.sslCertPasswordProtected",
            "http.sslKey",
            "http.sslTry",
            "http.sslVerify",
            "http.sslVersion",
            "http.userAgent",
            "http.version",
            "http.<url>.cookieFile",
            "http.<url>.curloptResolve",
            "http.<url>.delegation",
            "http.<url>.emptyAuth",
            "http.<url>.extraHeader",
            "http.<url>.followRedirects",
            "http.<url>.lowSpeedLimit",
            "http.<url>.maxRequests",
            "http.<url>.minSessions",
            "http.<url>.noEPSV",
            "http.<url>.pinnedPubkey",
            "http.<url>.postBuffer",
            "http.<url>.proxy",
            "http.<url>.proxyAuthMethod",
            "http.<url>.proxySSLCAInfo",
            "http.<url>.proxySSLCert",
            "http.<url>.proxySSLCertPasswordProtected",
            "http.<url>.proxySSLKey",
            "http.<url>.saveCookies",
            "http.<url>.schannelCheckRevoke",
            "http.<url>.schannelUseSSLCAInfo",
            "http.<url>.sslBackend",
            "http.<url>.sslCAInfo",
            "http.<url>.sslCAPath",
            "http.<url>.sslCert",
            "http.<url>.sslCertPasswordProtected",
            "http.<url>.sslKey",
            "http.<url>.sslTry",
            "http.<url>.sslVerify",
            "http.<url>.sslVersion",
            "http.<url>.userAgent",
            "http.<url>.version",
            "i18n.commitEncoding",
            "i18n.logOutputEncoding",
            "imap.authMethod",
            "imap.folder",
            "imap.host",
            "imap.pass",
            "imap.port",
            "imap.preformattedHTML",
            "imap.sslverify",
            "imap.tunnel",
            "imap.user",
            "includeIf.<condition>.path",
            "index.recordEndOfIndexEntries",
            "index.recordOffsetTable",
            "index.sparse",
            "index.threads",
            "index.version",
            "init.defaultBranch",
            "init.templateDir",
            "instaweb.browser",
            "instaweb.httpd",
            "instaweb.local",
            "instaweb.modulePath",
            "instaweb.port",
            "interactive.diffFilter",
            "interactive.singleKey",
            "log.abbrevCommit",
            "log.date",
            "log.decorate",
            "log.diffMerges",
            "log.excludeDecoration",
            "log.follow",
            "log.graphColors",
            "log.initialDecorationSet",
            "log.mailmap",
            "log.showRoot",
            "log.showSignature",
            "lsrefs.unborn",
            "mailinfo.scissors",
            "mailmap.blob",
            "mailmap.file",
            "maintenance.<task>.enabled",
            "maintenance.<task>.schedule",
            "maintenance.auto",
            "maintenance.commit-graph.auto",
            "maintenance.incremental-repack.auto",
            "maintenance.loose-objects.auto",
            "maintenance.strategy",
            "man.<tool>.cmd",
            "man.<tool>.path",
            "man.viewer",
            "merge.<driver>.driver",
            "merge.<driver>.name",
            "merge.<driver>.recursive",
            "merge.autoStash",
            "merge.branchdesc",
            "merge.conflictStyle",
            "merge.defaultToUpstream",
            "merge.directoryRenames",
            "merge.ff",
            "merge.guitool",
            "merge.log",
            "merge.renameLimit",
            "merge.renames",
            "merge.renormalize",
            "merge.stat",
            "merge.suppressDest",
            "merge.tool",
            "merge.verbosity",
            "merge.verifySignatures",
            "mergetool.<tool>.cmd",
            "mergetool.<tool>.hideResolved",
            "mergetool.<tool>.path",
            "mergetool.<tool>.trustExitCode",
            "mergetool.hideResolved",
            "mergetool.keepBackup",
            "mergetool.keepTemporaries",
            "mergetool.meld.hasOutput",
            "mergetool.meld.useAutoMerge",
            "mergetool.prompt",
            "mergetool.vimdiff.layout",
            "mergetool.writeToTemp",
            "notes.<name>.mergeStrategy",
            "notes.displayRef",
            "notes.mergeStrategy",
            "notes.rewrite.<command>",
            "notes.rewriteMode",
            "notes.rewriteRef",
            "pack.allowPackReuse",
            "pack.compression",
            "pack.deltaCacheLimit",
            "pack.deltaCacheSize",
            "pack.depth",
            "pack.indexVersion",
            "pack.island",
            "pack.islandCore",
            "pack.packSizeLimit",
            "pack.preferBitmapTips",
            "pack.threads",
            "pack.useBitmaps",
            "pack.useSparse",
            "pack.window",
            "pack.windowMemory",
            "pack.writeBitmapHashCache",
            "pack.writeBitmapLookupTable",
            "pack.writeBitmaps",
            "pack.writeReverseIndex",
            "pager.<cmd>",
            "pretty.<name>",
            "protocol.<name>.allow",
            "protocol.allow",
            "protocol.version",
            "pull.ff",
            "pull.octopus",
            "pull.rebase",
            "pull.twohead",
            "push.autoSetupRemote",
            "push.default",
            "push.followTags",
            "push.gpgSign",
            "push.negotiate",
            "push.pushOption",
            "push.recurseSubmodules",
            "push.useBitmaps",
            "push.useForceIfIncludes",
            "rebase.abbreviateCommands",
            "rebase.autoSquash",
            "rebase.autoStash",
            "rebase.backend",
            "rebase.forkPoint",
            "rebase.instructionFormat",
            "rebase.missingCommitsCheck",
            "rebase.rescheduleFailedExec",
            "rebase.stat",
            "rebase.updateRefs",
            "receive.advertiseAtomic",
            "receive.advertisePushOptions",
            "receive.autogc",
            "receive.certNonceSeed",
            "receive.certNonceSlop",
            "receive.denyCurrentBranch",
            "receive.denyDeleteCurrent",
            "receive.denyDeletes",
            "receive.denyNonFastForwards",
            "receive.fsck.<msg-id>",
            "receive.fsck.skipList",
            "receive.fsckObjects",
            "receive.hideRefs",
            "receive.keepAlive",
            "receive.maxInputSize",
            "receive.procReceiveRefs",
            "receive.shallowUpdate",
            "receive.unpackLimit",
            "receive.updateServerInfo",
            "remote.<name>.fetch",
            "remote.<name>.mirror",
            "remote.<name>.partialclonefilter",
            "remote.<name>.promisor",
            "remote.<name>.proxy",
            "remote.<name>.proxyAuthMethod",
            "remote.<name>.prune",
            "remote.<name>.pruneTags",
            "remote.<name>.push",
            "remote.<name>.pushurl",
            "remote.<name>.receivepack",
            "remote.<name>.skipDefaultUpdate",
            "remote.<name>.skipFetchAll",
            "remote.<name>.tagOpt",
            "remote.<name>.uploadpack",
            "remote.<name>.url",
            "remote.<name>.vcs",
            "remote.pushDefault",
            "remotes.<group>",
            "repack.cruftThreads",
            "repack.packKeptObjects",
            "repack.updateServerInfo",
            "repack.useDeltaBaseOffset",
            "repack.useDeltaIslands",
            "repack.writeBitmaps",
            "rerere.autoUpdate",
            "rerere.enabled",
            "revert.reference",
            "safe.bareRepository",
            "safe.directory",
            "sendemail.forbidSendmailVariables",
            "sendemail.identity",
            "sendemail.signedoffcc",
            "sendemail.smtpBatchSize",
            "sendemail.smtpEncryption",
            "sendemail.smtpReloginDelay",
            "sendemail.smtpsslcertpath",
            "sendemail.xmailer",
            "sequence.editor",
            "sendemail.<identity>.forbidSendmailVariables",
            "sendemail.<identity>.signedoffcc",
            "sendemail.<identity>.smtpBatchSize",
            "sendemail.<identity>.smtpEncryption",
            "sendemail.<identity>.smtpReloginDelay",
            "sendemail.<identity>.smtpsslcertpath",
            "sendemail.<identity>.xmailer",
            "sequence.<identity>.editor",
            "showBranch.default",
            "sparse.expectFilesOutsideOfPatterns",
            "splitIndex.maxPercentChange",
            "splitIndex.sharedIndexExpire",
            "ssh.variant",
            "stash.showIncludeUntracked",
            "stash.showPatch",
            "stash.showStat",
            "status.aheadBehind",
            "status.branch",
            "status.displayCommentPrefix",
            "status.relativePaths",
            "status.renameLimit",
            "status.renames",
            "status.short",
            "status.showStash",
            "status.showUntrackedFiles",
            "status.submoduleSummary",
            "submodule.<name>.active",
            "submodule.<name>.branch",
            "submodule.<name>.fetchRecurseSubmodules",
            "submodule.<name>.ignore",
            "submodule.<name>.update",
            "submodule.<name>.url",
            "submodule.active",
            "submodule.alternateErrorStrategy",
            "submodule.alternateLocation",
            "submodule.fetchJobs",
            "submodule.propagateBranches",
            "submodule.recurse",
            "tag.forceSignAnnotated",
            "tag.gpgSign",
            "tag.sort",
            "tar.umask",
            "trace2.configParams",
            "trace2.destinationDebug",
            "trace2.envVars",
            "trace2.eventBrief",
            "trace2.eventNesting",
            "trace2.eventTarget",
            "trace2.maxFiles",
            "trace2.normalBrief",
            "trace2.normalTarget",
            "trace2.perfBrief",
            "trace2.perfTarget",
            "transfer.advertiseSID",
            "transfer.credentialsInUrl",
            "transfer.fsckObjects",
            "transfer.hideRefs",
            "transfer.unpackLimit",
            "uploadarchive.allowUnreachable",
            "uploadpack.allowAnySHA1InWant",
            "uploadpack.allowFilter",
            "uploadpack.allowReachableSHA1InWant",
            "uploadpack.allowRefInWant",
            "uploadpack.allowTipSHA1InWant",
            "uploadpack.hideRefs",
            "uploadpack.keepAlive",
            "uploadpack.packObjectsHook",
            "uploadpackfilter.<filter>.allow",
            "uploadpackfilter.allow",
            "uploadpackfilter.tree.maxDepth",
            "url.<base>.insteadOf",
            "url.<base>.pushInsteadOf",
            "user.signingKey",
            "user.useConfigOnly",
            "versionsort.prereleaseSuffix",
            "versionsort.suffix",
            "web.browser",
            "worktree.guessRemote"
          ],
          "generators": [
            {
              "kind": "script",
              "script": [
                "git",
                "config",
                "--get-regexp",
                ".*"
              ]
            }
          ]
        },
        {
          "name": "value"
        }
      ]
    },
    {
      "name": "rebase",
      "description": "Reapply commits on top of another base tip",
      "options": [
        {
          "names": [
            "--onto"
          ],
          "description": "Starting point at which to create the new commits. If the --onto option is not specified, the starting point is <upstream>. May be any valid commit, and not just an existing branch name. As a special case, you may use 'A...B' as a shortcut for the merge base of A and B if there is exactly one merge base. You can leave out at most one of A and B, in which case it defaults to HEAD",
          "args": {
            "name": "newbase",
            "generators": [
              {
                "kind": "script",
                "script": [
                  "git",
                  "--no-optional-locks",
                  "log",
                  "--oneline"
                ]
              }
            ]
          }
        },
        {
          "names": [
            "--keep-base"
          ],
          "description": "Set the starting point at which to create the new commits to the merge base of <upstream> <branch>. Running git rebase --keep-base <upstream> <branch> is equivalent to running git rebase --onto <upstream>…​ <upstream>. This option is useful in the case where one is developing a feature on top of an upstream branch. While the feature is being worked on, the upstream branch may advance and it may not be the best idea to keep rebasing on top of the upstream but to keep the base commit as-is. Although both this option and --fork-point find the merge base between <upstream> and <branch>, this option uses the merge base as the starting point on which new commits will be created, whereas --fork-point uses the merge base to determine the set of commits which will be rebased"
        },
        {
          "names": [
            "--continue"
          ],
          "description": "Restart the rebasing process after having resolved a merge conflict"
        },
        {
          "names": [
            "--abort"
          ],
          "description": "Abort the rebase operation and reset HEAD to the original branch. If <branch> was provided when the rebase operation was started, then HEAD will be reset to <branch>. Otherwise HEAD will be reset to where it was when the rebase operation was started"
        },
        {
          "names": [
            "--quit"
          ],
          "description": "Abort the rebase operation but HEAD is not reset back to the original branch. The index and working tree are also left unchanged as a result. If a temporary stash entry was created using --autostash, it will be saved to the stash list"
        },
        {
          "names": [
            "--apply"
          ],
          "description": "Use applying strategies to rebase (calling git-am internally). This option may become a no-op in the future once the merge backend handles everything the apply one does"
        },
        {
          "names": [
            "--empty"
          ],
          "description": "How to handle commits that are not empty to start and are not clean cherry-picks of any upstream commit, but which become empty after rebasing (because they contain a subset of already upstream changes). With drop (the default), commits that become empty are dropped. With keep, such commits are kept. With ask (implied by --interactive), the rebase will halt when an empty commit is applied allowing you to choose whether to drop it, edit files more, or just commit the empty changes. Other options, like --exec, will use the default of drop unless -i/--interactive is explicitly specified. Note that commits which start empty are kept (unless --no-keep-empty is specified), and commits which are clean cherry-picks (as determined by git log --cherry-mark ...) are detected and dropped as a preliminary step (unless --reapply-cherry-picks is passed)",
          "args": {
            "isOptional": true,
            "suggestions": [
              "drop",
              "keep",
              "ask"
            ]
          }
        },
        {
          "names": [
            "--no-keep-empty"
          ],
          "description": "Do not keep commits that start empty before the rebase (i.e. that do not change anything from its parent) in the result. The default is to keep commits which start empty, since creating such commits requires passing the --allow-empty override flag to git commit, signifying that a user is very intentionally creating such a commit and thus wants to keep it. Usage of this flag will probably be rare, since you can get rid of commits that start empty by just firing up an interactive rebase and removing the lines corresponding to the commits you don’t want. This flag exists as a convenient shortcut, such as for cases where external tools generate many empty commits and you want them all removed. For commits which do not start empty but become empty after rebasing, see the --empty flag"
        },
        {
          "names": [
            "--keep-empty"
          ],
          "description": "Keep commits that start empty before the rebase (i.e. that do not change anything from its parent) in the result. The default is to keep commits which start empty, since creating such commits requires passing the --allow-empty override flag to git commit, signifying that a user is very intentionally creating such a commit and thus wants to keep it. Usage of this flag will probably be rare, since you can get rid of commits that start empty by just firing up an interactive rebase and removing the lines corresponding to the commits you don’t want. This flag exists as a convenient shortcut, such as for cases where external tools generate many empty commits and you want them all removed. For commits which do not start empty but become empty after rebasing, see the --empty flag"
        },
        {
          "names": [
            "--reapply-cherry-picks"
          ],
          "description": "Reapply all clean cherry-picks of any upstream commit instead of preemptively dropping them. (If these commits then become empty after rebasing, because they contain a subset of already upstream changes, the behavior towards them is controlled by the --empty flag). By default (or if --no-reapply-cherry-picks is given), these commits will be automatically dropped. Because this necessitates reading all upstream commits, this can be expensive in repos with a large number of upstream commits that need to be read. --reapply-cherry-picks allows rebase to forgo reading all upstream commits, potentially improving performance"
        },
        {
          "names": [
            "--no-reapply-cherry-picks"
          ],
          "description": "Do not reapply all clean cherry-picks of any upstream commit instead of preemptively dropping them"
        },
        {
          "names": [
            "--allow-empty-message"
          ],
          "description": "No-op. Rebasing commits with an empty message used to fail and this option would override that behavior, allowing commits with empty messages to be rebased. Now commits with an empty message do not cause rebasing to halt"
        },
        {
          "names": [
            "--skip"
          ],
          "description": "Restart the rebasing process by skipping the current patch"
        },
        {
          "names": [
            "--edit-todo"
          ],
          "description": "Edit the todo list during an interactive rebase"
        },
        {
          "names": [
            "--show-current-patch"
          ],
          "description": "Show the current patch in an interactive rebase or when rebase is stopped because of conflicts. This is the equivalent of git show REBASE_HEAD"
        },
        {
          "names": [
            "-m",
            "--merge"
          ],
          "description": "Use merging strategies to rebase. When the recursive (default) merge strategy is used, this allows rebase to be aware of renames on the upstream side. This is the default. Note that a rebase merge works by replaying each commit from the working branch on top of the <upstream> branch. Because of this, when a merge conflict happens, the side reported as ours is the so-far rebased series, starting with <upstream>, and theirs is the working branch. In other words, the sides are swapped"
        },
        {
          "names": [
            "-s",
            "--strategy"
          ],
          "description": "Use the given merge strategy. If there is no -s option git merge-recursive is used instead. This implies --merge. Because git rebase replays each commit from the working branch on top of the <upstream> branch using the given strategy, using the ours strategy simply empties all patches from the <branch>, which makes little sense",
          "args": {
            "name": "strategy",
            "isVariadic": true,
            "suggestions": [
              "resolve",
              "recursive",
              "octopus",
              "ours",
              "subtree"
            ]
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-X",
            "--strategy-option"
          ],
          "description": "Pass the <strategy-option> through to the merge strategy. This implies --merge and, if no strategy has been specified, -s recursive. Note the reversal of ours and theirs as noted above for the -m option",
          "args": {
            "name": "option",
            "suggestions": [
              "ours",
              "theirs",
              "patience",
              "diff-algorithm",
              "diff-algorithm=patience",
              "diff-algorithm=minimal",
              "diff-algorithm=histogram",
              "diff-algorithm=myers",
              "ignore-space-change",
              "ignore-all-space",
              "ignore-space-at-eol",
              "ignore-cr-at-eol",
              "renormalize",
              "no-renormalize",
              "no-renames",
              "find-renames",
              "subtree"
            ]
          }
        },
        {
          "names": [
            "--rerere-autoupdate"
          ],
          "description": "Allow the rerere mechanism to update the index with the result of auto-conflict resolution if possible"
        },
        {
          "names": [
            "--no-rerere-autoupdate"
          ],
          "description": "Allow the rerere mechanism to update the index with the result of auto-conflict resolution if possible"
        },
        {
          "names": [
            "-S",
            "--gpg-sign"
          ],
          "description": "GPG-sign commits. The keyid argument is optional and defaults to the committer identity; if specified, it must be stuck to the option without a space. --no-gpg-sign is useful to countermand both commit.gpgSign configuration variable, and earlier --gpg-sign",
          "args": {
            "name": "keyid",
            "isOptional": true
          }
        },
        {
          "names": [
            "--no-gpg-sign"
          ],
          "description": "Do not GPG-sign commits.--no-gpg-sign is useful to countermand both commit.gpgSign configuration variable, and earlier --gpg-sign"
        },
        {
          "names": [
            "-q",
            "--quiet"
          ],
          "description": "Be quiet. Implies --no-stat"
        },
        {
          "names": [
            "-v",
            "--verbose"
          ],
          "description": "Be verbose. Implies --stat"
        },
        {
          "names": [
            "--stat"
          ],
          "description": "Show a diffstat of what changed upstream since the last rebase. The diffstat is also controlled by the configuration option rebase.stat"
        },
        {
          "names": [
            "-n",
            "--no-stat"
          ],
          "description": "Do not show a diffstat as part of the rebase process"
        },
        {
          "names": [
            "--no-verify"
          ],
          "description": "This option bypasses the pre-rebase hook. See also githooks[5]"
        },
        {
          "names": [
            "--verify"
          ],
          "description": "Allows the pre-rebase hook to run, which is the default. This option can be used to override --no-verify. See also githooks[5]"
        },
        {
          "names": [
            "-C"
          ],
          "description": "Ensure at least <n> lines of surrounding context match before and after each change. When fewer lines of surrounding context exist they all must match. By default no context is ever ignored. Implies --apply",
          "args": {
            "name": "n"
          }
        },
        {
          "names": [
            "--no-ff",
            "--force-rebase",
            "-f"
          ],
          "description": "Individually replay all rebased commits instead of fast-forwarding over the unchanged ones. This ensures that the entire history of the rebased branch is composed of new commits. You may find this helpful after reverting a topic branch merge, as this option recreates the topic branch with fresh commits so it can be remerged successfully without needing to 'revert the reversion' (see the revert-a-faulty-merge How-To for details)"
        },
        {
          "names": [
            "--fork-point"
          ],
          "description": "Use reflog to find a better common ancestor between <upstream> and <branch> when calculating which commits have been introduced by <branch>. When --fork-point is active, fork_point will be used instead of <upstream> to calculate the set of commits to rebase, where fork_point is the result of git merge-base --fork-point <upstream> <branch> command (see git-merge-base[1]). If fork_point ends up being empty, the <upstream> will be used as a fallback. If <upstream> is given on the command line, then the default is --no-fork-point, otherwise the default is --fork-point. If your branch was based on <upstream> but <upstream> was rewound and your branch contains commits which were dropped, this option can be used with --keep-base in order to drop those commits from your branch"
        },
        {
          "names": [
            "--no-fork-point"
          ],
          "description": "Do not use reflog to find a better common ancestor between <upstream> and <branch> when calculating which commits have been introduced by <branch>. When --fork-point is active, fork_point will be used instead of <upstream> to calculate the set of commits to rebase, where fork_point is the result of git merge-base --fork-point <upstream> <branch> command (see git-merge-base[1]). If fork_point ends up being empty, the <upstream> will be used as a fallback. If <upstream> is given on the command line, then the default is --no-fork-point, otherwise the default is --fork-point. If your branch was based on <upstream> but <upstream> was rewound and your branch contains commits which were dropped, this option can be used with --keep-base in order to drop those commits from your branch"
        },
        {
          "names": [
            "--ignore-whitespace"
          ],
          "description": "Ignore whitespace differences when trying to reconcile differences. Currently, each backend implements an approximation of this behavior: apply backend: When applying a patch, ignore changes in whitespace in context lines. Unfortunately, this means that if the 'old' lines being replaced by the patch differ only in whitespace from the existing file, you will get a merge conflict instead of a successful patch application. merge backend: Treat lines with only whitespace changes as unchanged when merging. Unfortunately, this means that any patch hunks that were intended to modify whitespace and nothing else will be dropped, even if the other side had no changes that conflicted"
        },
        {
          "names": [
            "--whitespace"
          ],
          "description": "This flag is passed to the git apply program (see git-apply[1]) that applies the patch. Implies --apply",
          "args": {
            "name": "option"
          }
        },
        {
          "names": [
            "--committer-date-is-author-date"
          ],
          "description": "Instead of using the current time as the committer date, use the author date of the commit being rebased as the committer date. This option implies --force-rebase"
        },
        {
          "names": [
            "--ignore-date",
            "--reset-author-date"
          ],
          "description": "Instead of using the author date of the original commit, use the current time as the author date of the rebased commit. This option implies --force-rebase"
        },
        {
          "names": [
            "--signoff"
          ],
          "description": "Add a Signed-off-by trailer to all the rebased commits. Note that if --interactive is given then only commits marked to be picked, edited or reworded will have the trailer added"
        },
        {
          "names": [
            "-i",
            "--interactive"
          ],
          "description": "Make a list of the commits which are about to be rebased. Let the user edit that list before rebasing. This mode can also be used to split commits (see SPLITTING COMMITS below). The commit list format can be changed by setting the configuration option rebase.instructionFormat. A customized instruction format will automatically have the long commit hash prepended to the format"
        },
        {
          "names": [
            "-r",
            "--rebase-merges"
          ],
          "description": "By default, a rebase will simply drop merge commits from the todo list, and put the rebased commits into a single, linear branch. With --rebase-merges, the rebase will instead try to preserve the branching structure within the commits that are to be rebased, by recreating the merge commits. Any resolved merge conflicts or manual amendments in these merge commits will have to be resolved/re-applied manually. By default, or when no-rebase-cousins was specified, commits which do not have <upstream> as direct ancestor will keep their original branch point, i.e. commits that would be excluded by git-log[1]'s --ancestry-path option will keep their original ancestry by default. If the rebase-cousins mode is turned on, such commits are instead rebased onto <upstream> (or <onto>, if specified). The --rebase-merges mode is similar in spirit to the deprecated --preserve-merges but works with interactive rebases, where commits can be reordered, inserted and dropped at will. It is currently only possible to recreate the merge commits using the recursive merge strategy; Different merge strategies can be used only via explicit exec git merge -s <strategy> [...] commands",
          "args": {
            "name": "mode",
            "isOptional": true,
            "suggestions": [
              "rebase-cousins",
              "no-rebase-cousins"
            ]
          }
        },
        {
          "names": [
            "-x",
            "--exec"
          ],
          "description": "Append 'exec <cmd>' after each line creating a commit in the final history. <cmd> will be interpreted as one or more shell commands. Any command that fails will interrupt the rebase, with exit code 1. You may execute several commands by either using one instance of --exec with several commands: git rebase -i --exec 'cmd1 && cmd2 && ...' or by giving more than one --exec: git rebase -i --exec 'cmd1' --exec 'cmd2' --exec ... If --autosquash is used, 'exec' lines will not be appended for the intermediate commits, and will only appear at the end of each squash/fixup series. This uses the --interactive machinery internally, but it can be run without an explicit --interactive",
          "args": {
            "name": "cmd"
          }
        },
        {
          "names": [
            "--root"
          ],
          "description": "Rebase all commits reachable from <branch>, instead of limiting them with an <upstream>. This allows you to rebase the root commit(s) on a branch. When used with --onto, it will skip changes already contained in <newbase> (instead of <upstream>) whereas without --onto it will operate on every change. When used together with both --onto and --preserve-merges, all root commits will be rewritten to have <newbase> as parent instead"
        },
        {
          "names": [
            "--autosquash"
          ],
          "description": "When the commit log message begins with 'squash! …​' (or 'fixup! …​'), and there is already a commit in the todo list that matches the same ..., automatically modify the todo list of rebase -i so that the commit marked for squashing comes right after the commit to be modified, and change the action of the moved commit from pick to squash (or fixup). A commit matches the ... if the commit subject matches, or if the ... refers to the commit’s hash. As a fall-back, partial matches of the commit subject work, too. The recommended way to create fixup/squash commits is by using the --fixup/--squash options of git-commit[1]"
        },
        {
          "names": [
            "--no-autosquash"
          ],
          "description": "When the commit log message begins with 'squash! …' (or 'fixup! …'), and there is already a commit in the todo list that matches the same ..., automatically modify the todo list of rebase -i so that the commit marked for squashing comes right after the commit to be modified, and change the action of the moved commit from pick to squash (or fixup). A commit matches the ... if the commit subject matches, or if the ... refers to the commit’s hash. As a fall-back, partial matches of the commit subject work, too. The recommended way to create fixup/squash commits is by using the --fixup/--squash options of git-commit[1]"
        },
        {
          "names": [
            "--autostash"
          ],
          "description": "Automatically create a temporary stash entry before the operation begins, and apply it after the operation ends. This means that you can run rebase on a dirty worktree. However, use with care: the final stash application after a successful rebase might result in non-trivial conflicts"
        },
        {
          "names": [
            "--no-autostash"
          ],
          "description": "Do not automatically create a temporary stash entry before the operation begins, and apply it after the operation ends. This means that you can run rebase on a dirty worktree. However, use with care: the final stash application after a successful rebase might result in non-trivial conflicts"
        },
        {
          "names": [
            "--reschedule-failed-exec"
          ],
          "description": "Automatically reschedule exec commands that failed. This only makes sense in interactive mode (or when an --exec option was provided)"
        },
        {
          "names": [
            "--no-reschedule-failed-exec"
          ],
          "description": "Do not automatically reschedule exec commands that failed. This only makes sense in interactive mode (or when an --exec option was provided)"
        }
      ],
      "args": [
        {
          "name": "base",
          "isOptional": true,
          "suggestions": [
            "-"
          ],
          "generators": [
            {
              "kind": "script",
              "script": [
                "git",
                "--no-optional-locks",
                "branch",
                "--no-color",
                "--sort=-committerdate"
              ]
            }
          ]
        },
        {
          "name": "new base",
          "isOptional": true,
          "generators": [
            {
              "kind": "script",
              "script": [
                "git",
                "--no-optional-locks",
                "branch",
                "--no-color",
                "--sort=-committerdate"
              ]
            }
          ]
        }
      ]
    },
    {
      "name": "add",
      "description": "Add file contents to the index",
      "options": [
        {
          "names": [
            "-n",
            "--dry-run"
          ],
          "description": "Don’t actually add the file(s), just show if they exist and/or will be ignored"
        },
        {
          "names": [
            "-v",
            "--verbose"
          ],
          "description": "Be verbose"
        },
        {
          "names": [
            "-f",
            "--force"
          ],
          "description": "Allow adding otherwise ignored files"
        },
        {
          "names": [
            "-i",
            "--interactive"
          ],
          "description": "Add modified contents in the working tree interactively to the index. Optional path arguments may be supplied to limit operation to a subset of the working tree. See “Interactive mode” for details"
        },
        {
          "names": [
            "-p",
            "--patch"
          ],
          "description": "Interactively choose hunks of patch between the index and the work tree and add them to the index. This gives the user a chance to review the difference before adding modified contents to the index"
        },
        {
          "names": [
            "-e",
            "--edit"
          ],
          "description": "Open the diff vs. the index in an editor and let the user edit it. After the editor was closed, adjust the hunk headers and apply the patch to the index"
        },
        {
          "names": [
            "-u",
            "--update"
          ],
          "description": "Update the index just where it already has an entry matching <pathspec>. This removes as well as modifies index entries to match the working tree, but adds no new files"
        },
        {
          "names": [
            "-A",
            "--all",
            "--no-ignore-removal"
          ],
          "description": "Update the index not only where the working tree has a file matching <pathspec> but also where the index already has an entry. This adds, modifies, and removes index entries to match the working tree"
        },
        {
          "names": [
            "--no-all",
            "--ignore-removal"
          ],
          "description": "Update the index by adding new files that are unknown to the index and files modified in the working tree, but ignore files that have been removed from the working tree. This option is a no-op when no <pathspec> is used"
        },
        {
          "names": [
            "-N",
            "--intent-to-add"
          ],
          "description": "Record only the fact that the path will be added later. An entry for the path is placed in the index with no content. This is useful for, among other things, showing the unstaged content of such files with git diff and committing them with git commit -a"
        },
        {
          "names": [
            "--refresh"
          ],
          "description": "Don’t add the file(s), but only refresh their stat() information in the index"
        },
        {
          "names": [
            "--ignore-errors"
          ],
          "description": "If some files could not be added because of errors indexing them, do not abort the operation, but continue adding the others. The command shall still exit with non-zero status. The configuration variable add.ignoreErrors can be set to true to make this the default behaviour"
        },
        {
          "names": [
            "--ignore-missing"
          ],
          "description": "This option can only be used together with --dry-run. By using this option the user can check if any of the given files would be ignored, no matter if they are already present in the work tree or not"
        },
        {
          "names": [
            "--no-warn-embedded-repo"
          ],
          "description": "By default, git add will warn when adding an embedded repository to the index without using git submodule add to create an entry in .gitmodules. This option will suppress the warning (e.g., if you are manually performing operations on submodules)"
        },
        {
          "names": [
            "--renormalize"
          ],
          "description": "Apply the 'clean' process freshly to all tracked files to forcibly add them again to the index. This is useful after changing core.autocrlf configuration or the text attribute in order to correct files added with wrong CRLF/LF line endings. This option implies -u"
        },
        {
          "names": [
            "--chmod"
          ],
          "description": "Override the executable bit of the added files. The executable bit is only changed in the index, the files on disk are left unchanged",
          "args": {
            "suggestions": [
              "+x",
              "-x"
            ]
          }
        },
        {
          "names": [
            "--pathspec-from-file"
          ],
          "description": "Pathspec is passed in <file> instead of commandline args. If <file> is exactly - then standard input is used. Pathspec elements are separated by LF or CR/LF. Pathspec elements can be quoted as explained for the configuration variable core.quotePath (see git-config[1]). See also --pathspec-file-nul and global --literal-pathspecs",
          "args": {
            "name": "File",
            "description": "File with pathspec"
          }
        },
        {
          "names": [
            "--pathspec-file-nul"
          ],
          "description": "Only meaningful with --pathspec-from-file. Pathspec elements are separated with NUL character and all other characters are taken literally (including newlines and quotes)"
        },
        {
          "names": [
            "--"
          ],
          "description": "This option can be used to separate command-line options from the list of files"
        }
      ],
      "args": [
        {
          "name": "pathspec",
          "isVariadic": true,
          "isOptional": true,
          "generators": [
            {
              "kind": "script",
              "script": [
                "git",
                "--no-optional-locks",
                "status",
                "--short"
              ]
            }
          ]
        }
      ]
    },
    {
      "name": "stage",
      "description": "Add file contents to the staging area",
      "options": [
        {
          "names": [
            "-n",
            "--dry-run"
          ],
          "description": "Don’t actually add the file(s), just show if they exist and/or will be ignored"
        },
        {
          "names": [
            "-v",
            "--verbose"
          ],
          "description": "Be verbose"
        },
        {
          "names": [
            "-f",
            "--force"
          ],
          "description": "Allow adding otherwise ignored files"
        },
        {
          "names": [
            "-i",
            "--interactive"
          ],
          "description": "Add modified contents in the working tree interactively to the index. Optional path arguments may be supplied to limit operation to a subset of the working tree. See “Interactive mode” for details"
        },
        {
          "names": [
            "-p",
            "--patch"
          ],
          "description": "Interactively choose hunks of patch between the index and the work tree and add them to the index. This gives the user a chance to review the difference before adding modified contents to the index"
        },
        {
          "names": [
            "-e",
            "--edit"
          ],
          "description": "Open the diff vs. the index in an editor and let the user edit it. After the editor was closed, adjust the hunk headers and apply the patch to the index"
        },
        {
          "names": [
            "-u",
            "--update"
          ],
          "description": "Update the index just where it already has an entry matching <pathspec>. This removes as well as modifies index entries to match the working tree, but adds no new files"
        },
        {
          "names": [
            "-A",
            "--all",
            "--no-ignore-removal"
          ],
          "description": "Update the index not only where the working tree has a file matching <pathspec> but also where the index already has an entry. This adds, modifies, and removes index entries to match the working tree"
        },
        {
          "names": [
            "--no-all",
            "--ignore-removal"
          ],
          "description": "Update the index by adding new files that are unknown to the index and files modified in the working tree, but ignore files that have been removed from the working tree. This option is a no-op when no <pathspec> is used"
        },
        {
          "names": [
            "-N",
            "--intent-to-add"
          ],
          "description": "Record only the fact that the path will be added later. An entry for the path is placed in the index with no content. This is useful for, among other things, showing the unstaged content of such files with git diff and committing them with git commit -a"
        },
        {
          "names": [
            "--refresh"
          ],
          "description": "Don’t add the file(s), but only refresh their stat() information in the index"
        },
        {
          "names": [
            "--ignore-errors"
          ],
          "description": "If some files could not be added because of errors indexing them, do not abort the operation, but continue adding the others. The command shall still exit with non-zero status. The configuration variable add.ignoreErrors can be set to true to make this the default behaviour"
        },
        {
          "names": [
            "--ignore-missing"
          ],
          "description": "This option can only be used together with --dry-run. By using this option the user can check if any of the given files would be ignored, no matter if they are already present in the work tree or not"
        },
        {
          "names": [
            "--no-warn-embedded-repo"
          ],
          "description": "By default, git add will warn when adding an embedded repository to the index without using git submodule add to create an entry in .gitmodules. This option will suppress the warning (e.g., if you are manually performing operations on submodules)"
        },
        {
          "names": [
            "--renormalize"
          ],
          "description": "Apply the 'clean' process freshly to all tracked files to forcibly add them again to the index. This is useful after changing core.autocrlf configuration or the text attribute in order to correct files added with wrong CRLF/LF line endings. This option implies -u"
        },
        {
          "names": [
            "--chmod"
          ],
          "description": "Override the executable bit of the added files. The executable bit is only changed in the index, the files on disk are left unchanged",
          "args": {
            "suggestions": [
              "+x",
              "-x"
            ]
          }
        },
        {
          "names": [
            "--pathspec-from-file"
          ],
          "description": "Pathspec is passed in <file> instead of commandline args. If <file> is exactly - then standard input is used. Pathspec elements are separated by LF or CR/LF. Pathspec elements can be quoted as explained for the configuration variable core.quotePath (see git-config[1]). See also --pathspec-file-nul and global --literal-pathspecs",
          "args": {
            "name": "File",
            "description": "File with pathspec"
          }
        },
        {
          "names": [
            "--pathspec-file-nul"
          ],
          "description": "Only meaningful with --pathspec-from-file. Pathspec elements are separated with NUL character and all other characters are taken literally (including newlines and quotes)"
        },
        {
          "names": [
            "--"
          ],
          "description": "This option can be used to separate command-line options from the list of files"
        }
      ],
      "args": [
        {
          "name": "pathspec",
          "isVariadic": true,
          "isOptional": true,
          "generators": [
            {
              "kind": "script",
              "script": [
                "git",
                "--no-optional-locks",
                "status",
                "--short"
              ]
            }
          ]
        }
      ]
    },
    {
      "name": "status",
      "description": "Show the working tree status",
      "options": [
        {
          "names": [
            "-s",
            "--short"
          ],
          "description": "Give the output in the short-format"
        },
        {
          "names": [
            "-v",
            "--verbose"
          ],
          "description": "Be verbose"
        },
        {
          "names": [
            "-b",
            "--branch"
          ],
          "description": "Show branch information"
        },
        {
          "names": [
            "--show-stash"
          ],
          "description": "Show stash information"
        },
        {
          "names": [
            "--porcelain"
          ],
          "description": "Give the output in the short-format",
          "args": {
            "name": "version",
            "isOptional": true
          }
        },
        {
          "names": [
            "--ahead-behind"
          ],
          "description": "Display full ahead/behind values"
        },
        {
          "names": [
            "--no-ahead-behind"
          ],
          "description": "Do not display full ahead/behind values"
        },
        {
          "names": [
            "--column"
          ],
          "description": "Display full ahead/behind values",
          "args": {
            "name": "options",
            "description": "Defaults to always",
            "isOptional": true
          }
        },
        {
          "names": [
            "--no-column"
          ],
          "description": "Do not display untracked files in columns",
          "args": {
            "name": "options",
            "description": "Defaults to never",
            "isOptional": true
          }
        },
        {
          "names": [
            "--long"
          ],
          "description": "Show status in long format (default)"
        },
        {
          "names": [
            "-z",
            "--null"
          ],
          "description": "Terminate entries with NUL"
        },
        {
          "names": [
            "-u",
            "--untracked-files"
          ],
          "description": "Show untracked files",
          "args": {
            "isOptional": true,
            "suggestions": [
              "all",
              "normal",
              "no"
            ]
          }
        },
        {
          "names": [
            "--ignore-submodules"
          ],
          "description": "Ignore changes to submodules when looking for changes",
          "args": {
            "name": "when",
            "isOptional": true,
            "suggestions": [
              "all",
              "dirty",
              "untracked",
              "none"
            ]
          }
        },
        {
          "names": [
            "--ignored"
          ],
          "description": "Show ignored files",
          "args": {
            "isOptional": true,
            "suggestions": [
              "traditional",
              "matching",
              "no"
            ]
          }
        },
        {
          "names": [
            "--no-renames"
          ],
          "description": "Do not detect renames"
        },
        {
          "names": [
            "--renames"
          ],
          "description": "Turn on rename detection regardless of user configuration"
        },
        {
          "names": [
            "--find-renames"
          ],
          "description": "Turn on rename detection, optionally setting the similarity threshold",
          "args": {
            "name": "n",
            "isOptional": true
          }
        }
      ],
      "args": [
        {
          "name": "pathspec",
          "isVariadic": true,
          "isOptional": true,
          "generators": [
            {
              "kind": "script",
              "script": [
                "git",
                "--no-optional-locks",
                "status",
                "--short"
              ]
            }
          ]
        }
      ]
    },
    {
      "name": "clean",
      "description": "Shows which files would be removed from working directory",
      "options": [
        {
          "names": [
            "-d"
          ],
          "description": "Normally, when no <path> is specified, git clean will not recurse into untracked directories to avoid removing too much. Specify -d to have it recurse into such directories as well. If any paths are specified, -d is irrelevant; all untracked files matching the specified paths (with exceptions for nested git directories mentioned under --force) will be removed"
        },
        {
          "names": [
            "-f",
            "--force"
          ],
          "description": "If the Git configuration variable clean.requireForce is not set to false, git clean will refuse to delete files or directories unless given -f or -i"
        },
        {
          "names": [
            "-i",
            "--interactive"
          ],
          "description": "Show what would be done and clean files interactively"
        },
        {
          "names": [
            "-n",
            "--dry-run"
          ],
          "description": "Don’t actually remove anything, just show what would be done"
        },
        {
          "names": [
            "-q",
            "--quiet"
          ],
          "description": "Be quiet, only report errors, but not the files that are successfully removed"
        },
        {
          "names": [
            "-e",
            "--exclude"
          ],
          "description": "Use the given exclude pattern in addition to the standard ignore rules",
          "args": {
            "name": "pattern"
          }
        },
        {
          "names": [
            "-x"
          ],
          "description": "Don’t use the standard ignore rules (see gitignore(5)), but still use the ignore rules given with -e options from the command line. This allows removing all untracked files, including build products. This can be used (possibly in conjunction with git restore or git reset) to create a pristine working directory to test a clean build"
        },
        {
          "names": [
            "-X"
          ],
          "description": "Remove only files ignored by Git. This may be useful to rebuild everything from scratch, but keep manually created files"
        }
      ],
      "args": [
        {
          "name": "path"
        }
      ]
    },
    {
      "name": "revert",
      "description": "Create new commit that undoes all of the changes made in <commit>, then apply it to the current branch",
      "args": [
        {
          "name": "commit",
          "isOptional": true,
          "generators": [
            {
              "kind": "script",
              "script": [
                "git",
                "--no-optional-locks",
                "log",
                "--oneline"
              ]
            }
          ]
        }
      ]
    },
    {
      "name": "ls-remote",
      "description": "List references in a remote repository"
    },
    {
      "name": "push",
      "description": "Update remote refs",
      "options": [
        {
          "names": [
            "--all"
          ],
          "description": "Push all branches (i.e. refs under refs/heads/); cannot be used with other <refspec>"
        },
        {
          "names": [
            "--prune"
          ],
          "description": "Remove remote branches that don't have a local counterpart"
        },
        {
          "names": [
            "--mirror"
          ],
          "description": "Instead of naming each ref to push, specifies that all refs under refs/ be mirrored to the remote repository"
        },
        {
          "names": [
            "-n",
            "--dry-run"
          ],
          "description": "Do everything except actually send the updates"
        },
        {
          "names": [
            "--porcelain"
          ],
          "description": "Produce machine-readable output. The output status line for each ref will be tab-separated and sent to stdout instead of stderr"
        },
        {
          "names": [
            "-d",
            "--delete"
          ],
          "description": "All listed refs are deleted from the remote repository. This is the same as prefixing all refs with a colon"
        },
        {
          "names": [
            "--tags"
          ],
          "description": "All refs under refs/tags are pushed, in addition to refspecs explicitly listed on the command line"
        },
        {
          "names": [
            "--follow-tags"
          ],
          "description": "Push all the refs that would be pushed without this option, and also push annotated tags in refs/tags that are missing from the remote but are pointing at commit-ish that are reachable from the refs being pushed. This can also be specified with configuration variable push.followTags"
        },
        {
          "names": [
            "--signed"
          ],
          "description": "GPG-sign the push request to update refs on the receiving side, to allow it to be checked by the hooks and/or be logged. If false or --no-signed, no signing will be attempted. If true or --signed, the push will fail if the server does not support signed pushes. If set to if-asked, sign if and only if the server supports signed pushes. The push will also fail if the actual call to gpg --sign fails. See git-receive-pack(1) for the details on the receiving end",
          "args": {
            "isOptional": true,
            "suggestions": [
              "true",
              "false",
              "if-asked"
            ]
          }
        },
        {
          "names": [
            "--no-signed"
          ],
          "description": "GPG-sign the push request to update refs on the receiving side, to allow it to be checked by the hooks and/or be logged. If false or --no-signed, no signing will be attempted. If true or --signed, the push will fail if the server does not support signed pushes. If set to if-asked, sign if and only if the server supports signed pushes. The push will also fail if the actual call to gpg --sign fails. See git-receive-pack(1) for the details on the receiving end"
        },
        {
          "names": [
            "--atomic"
          ],
          "description": "Use an atomic transaction on the remote side if available. Either all refs are updated, or on error, no refs are updated. If the server does not support atomic pushes the push will fail"
        },
        {
          "names": [
            "--no-atomic"
          ],
          "description": "Use an atomic transaction on the remote side if available. Either all refs are updated, or on error, no refs are updated. If the server does not support atomic pushes the push will fail"
        },
        {
          "names": [
            "-f",
            "--force"
          ],
          "description": "Usually, the command refuses to update a remote ref that is not an ancestor of the local ref used to overwrite it. Also, when --force-with-lease option is used, the command refuses to update a remote ref whose current value does not match what is expected. This flag disables these checks, and can cause the remote repository to lose commits; use it with care"
        },
        {
          "names": [
            "--repo"
          ],
          "description": "This option is equivalent to the <repository> argument. If both are specified, the command-line argument takes precedence",
          "args": {
            "name": "repository"
          }
        },
        {
          "names": [
            "-u",
            "--set-upstream"
          ],
          "description": "For every branch that is up to date or successfully pushed, add upstream (tracking) reference, used by argument-less git-pull(1) and other commands"
        },
        {
          "names": [
            "--thin"
          ],
          "description": "These options are passed to git-send-pack(1). A thin transfer significantly reduces the amount of sent data when the sender and receiver share many of the same objects in common. The default is --thin"
        },
        {
          "names": [
            "--no-thin"
          ],
          "description": "These options are passed to git-send-pack(1). A thin transfer significantly reduces the amount of sent data when the sender and receiver share many of the same objects in common. The default is --thin"
        },
        {
          "names": [
            "-q",
            "--quiet"
          ],
          "description": "Suppress all output, including the listing of updated refs, unless an error occurs. Progress is not reported to the standard error stream"
        },
        {
          "names": [
            "-v",
            "--verbose"
          ],
          "description": "Run verbosely"
        },
        {
          "names": [
            "--progress"
          ],
          "description": "Progress status is reported on the standard error stream by default when it is attached to a terminal, unless -q is specified. This flag forces progress status even if the standard error stream is not directed to a terminal"
        },
        {
          "names": [
            "--no-recurse-submodules"
          ],
          "description": "May be used to make sure all submodule commits used by the revisions to be pushed are available on a remote-tracking branch. If check is used Git will verify that all submodule commits that changed in the revisions to be pushed are available on at least one remote of the submodule. If any commits are missing the push will be aborted and exit with non-zero status. If on-demand is used all submodules that changed in the revisions to be pushed will be pushed. If on-demand was not able to push all necessary revisions it will also be aborted and exit with non-zero status. If only is used all submodules will be recursively pushed while the superproject is left unpushed. A value of no or using --no-recurse-submodules can be used to override the push.recurseSubmodules configuration variable when no submodule recursion is required"
        },
        {
          "names": [
            "--recurse-submodules"
          ],
          "description": "May be used to make sure all submodule commits used by the revisions to be pushed are available on a remote-tracking branch. If check is used Git will verify that all submodule commits that changed in the revisions to be pushed are available on at least one remote of the submodule. If any commits are missing the push will be aborted and exit with non-zero status. If on-demand is used all submodules that changed in the revisions to be pushed will be pushed. If on-demand was not able to push all necessary revisions it will also be aborted and exit with non-zero status. If only is used all submodules will be recursively pushed while the superproject is left unpushed. A value of no or using --no-recurse-submodules can be used to override the push.recurseSubmodules configuration variable when no submodule recursion is required",
          "args": {
            "suggestions": [
              "check",
              "on-demand",
              "only",
              "no"
            ]
          }
        },
        {
          "names": [
            "--verify"
          ],
          "description": "Turn on the pre-push hook. The default is --verify, giving the hook a chance to prevent the push. With"
        },
        {
          "names": [
            "--no-verify"
          ],
          "description": "Turn off the pre-push hook. The default is --verify, giving the hook a chance to prevent the push. With"
        },
        {
          "names": [
            "-4",
            "--ipv4"
          ],
          "description": "Use IPv4 addresses only, ignoring IPv6 addresses"
        },
        {
          "names": [
            "-6",
            "--ipv6"
          ],
          "description": "Use IPv6 addresses only, ignoring IPv4 addresses"
        },
        {
          "names": [
            "-o",
            "--push-option"
          ],
          "description": "Transmit the given string to the server, which passes them to the pre-receive as well as the post-receive hook. The given string must not contain a NUL or LF character. When multiple --push-option=<option> are given, they are all sent to the other side in the order listed on the command line. When no --push-option=<option> is given from the command line, the values of configuration variable push.pushOption are used instead",
          "args": {
            "name": "option"
          }
        },
        {
          "names": [
            "--receive-pack",
            "--exec"
          ],
          "description": "Path to the git-receive-pack program on the remote end. Sometimes useful when pushing to a remote repository over ssh, and you do not have the program in a directory on the default $PATH",
          "args": {
            "name": "git-receive-pack"
          }
        },
        {
          "names": [
            "--no-force-with-lease"
          ],
          "description": "Cancel all the previous --force-with-lease on the command line"
        },
        {
          "names": [
            "--force-with-lease"
          ],
          "description": "Protect the named ref (alone), if it is going to be updated, by requiring its current value to be the same as the specified value <expect> (which is allowed to be different from the remote-tracking branch we have for the refname, or we do not even have to have such a remote-tracking branch when this form is used). If <expect> is the empty string, then the named ref must not already exist",
          "args": {
            "name": "refname[:expect]",
            "isOptional": true
          }
        }
      ],
      "args": [
        {
          "name": "remote",
          "isOptional": true,
          "generators": [
            {
              "kind": "script",
              "script": [
                "git",
                "--no-optional-locks",
                "remote",
                "-v"
              ]
            }
          ]
        },
        {
          "name": "branch",
          "isOptional": true,
          "generators": [
            {
              "kind": "script",
              "script": [
                "git",
                "--no-optional-locks",
                "branch",
                "--no-color",
                "--sort=-committerdate"
              ]
            }
          ]
        }
      ]
    },
    {
      "name": "pull",
      "description": "Integrate with another repository",
      "options": [
        {
          "names": [
            "--rebase",
            "-r"
          ],
          "description": "Fetch the remote’s copy of current branch and rebases it into the local copy",
          "args": {
            "name": "remote",
            "isOptional": true,
            "suggestions": [
              "false",
              "true",
              "merges",
              "preserve",
              "interactive"
            ],
            "generators": [
              {
                "kind": "script",
                "script": [
                  "git",
                  "--no-optional-locks",
                  "remote",
                  "-v"
                ]
              }
            ]
          }
        },
        {
          "names": [
            "--no-rebase"
          ],
          "description": "Override earlier --rebase"
        },
        {
          "names": [
            "--commit"
          ],
          "description": "Perform the merge and commit the result. This option can be used to override --no-commit"
        },
        {
          "names": [
            "--no-commit"
          ],
          "description": "Perform the merge and stop just before creating a merge commit, to give the user a chance to inspect and further tweak the merge result before committing"
        },
        {
          "names": [
            "--edit",
            "-e"
          ],
          "description": "Invoke an editor before committing successful mechanical merge to further edit the auto-generated merge message, so that the user can explain and justify the merge"
        },
        {
          "names": [
            "--no-edit"
          ],
          "description": "The --no-edit option can be used to accept the auto-generated message (this is generally discouraged). The --edit (or -e) option is still useful if you are giving a draft message with the -m option from the command line and want to edit it in the editor"
        },
        {
          "names": [
            "--cleanup"
          ],
          "description": "This option determines how the merge message will be cleaned up before committing. See git-commit[1] for more details. In addition, if the <mode> is given a value of scissors, scissors will be appended to MERGE_MSG before being passed on to the commit machinery in the case of a merge conflict",
          "args": {
            "name": "mode",
            "suggestions": [
              "strip",
              "whitespace",
              "verbatim",
              "scissors",
              "default"
            ]
          }
        },
        {
          "names": [
            "--ff"
          ],
          "description": "When possible resolve the merge as a fast-forward (only update the branch pointer to match the merged branch; do not create a merge commit). When not possible (when the merged-in history is not a descendant of the current history), create a merge commit"
        },
        {
          "names": [
            "--no-ff"
          ],
          "description": "Create a merge commit in all cases, even when the merge could instead be resolved as a fast-forward"
        },
        {
          "names": [
            "--ff-only"
          ],
          "description": "Resolve the merge as a fast-forward when possible. When not possible, refuse to merge and exit with a non-zero status"
        },
        {
          "names": [
            "-S",
            "--gpg-sign"
          ],
          "description": "GPG-sign the resulting merge commit. The keyid argument is optional and defaults to the committer identity; if specified, it must be stuck to the option without a space",
          "args": {
            "name": "keyid",
            "isOptional": true
          }
        },
        {
          "names": [
            "--no-gpg-sign"
          ],
          "description": "Is useful to countermand both commit.gpgSign configuration variable, and earlier --gpg-sign"
        },
        {
          "names": [
            "--log"
          ],
          "description": "In addition to branch names, populate the log message with one-line descriptions from at most <n> actual commits that are being merged. See also git-fmt-merge-msg[1]",
          "args": {
            "name": "n",
            "isOptional": true
          }
        },
        {
          "names": [
            "--no-log"
          ],
          "description": "Do not list one-line descriptions from the actual commits being merged"
        },
        {
          "names": [
            "--signoff"
          ],
          "description": "Add a Signed-off-by trailer by the committer at the end of the commit log message. The meaning of a signoff depends on the project to which you’re committing. For example, it may certify that the committer has the rights to submit the work under the project’s license or agrees to some contributor representation, such as a Developer Certificate of Origin. (See http://developercertificate.org for the one used by the Linux kernel and Git projects.) Consult the documentation or leadership of the project to which you’re contributing to understand how the signoffs are used in that project"
        },
        {
          "names": [
            "--no-signoff"
          ],
          "description": "Can be used to countermand an earlier --signoff option on the command line"
        },
        {
          "names": [
            "--stat"
          ],
          "description": "Show a diffstat at the end of the merge. The diffstat is also controlled by the configuration option merge.stat"
        },
        {
          "names": [
            "-n",
            "--no-stat"
          ],
          "description": "Do not show a diffstat at the end of the merge"
        },
        {
          "names": [
            "--squash"
          ],
          "description": "With --squash, --commit is not allowed, and will fail. Produce the working tree and index state as if a real merge happened (except for the merge information), but do not actually make a commit, move the HEAD, or record $GIT_DIR/MERGE_HEAD (to cause the next git commit command to create a merge commit). This allows you to create a single commit on top of the current branch whose effect is the same as merging another branch (or more in case of an octopus)"
        },
        {
          "names": [
            "--no-squash"
          ],
          "description": "Perform the merge and commit the result. This option can be used to override --squash"
        },
        {
          "names": [
            "--no-verify"
          ],
          "description": "This option bypasses the pre-merge and commit-msg hooks. See also githooks[5]"
        },
        {
          "names": [
            "-s",
            "--strategy"
          ],
          "description": "Use the given merge strategy; can be supplied more than once to specify them in the order they should be tried. If there is no -s option, a built-in list of strategies is used instead (git merge-recursive when merging a single head, git merge-octopus otherwise)",
          "args": {
            "name": "strategy",
            "isVariadic": true,
            "suggestions": [
              "resolve",
              "recursive",
              "octopus",
              "ours",
              "subtree"
            ]
          }
        },
        {
          "names": [
            "-X",
            "--strategy-option"
          ],
          "description": "Pass merge strategy specific option through to the merge strategy",
          "args": {
            "name": "option",
            "suggestions": [
              "ours",
              "theirs",
              "patience",
              "diff-algorithm",
              "diff-algorithm=patience",
              "diff-algorithm=minimal",
              "diff-algorithm=histogram",
              "diff-algorithm=myers",
              "ignore-space-change",
              "ignore-all-space",
              "ignore-space-at-eol",
              "ignore-cr-at-eol",
              "renormalize",
              "no-renormalize",
              "no-renames",
              "find-renames",
              "subtree"
            ]
          }
        },
        {
          "names": [
            "--verify-signatures"
          ],
          "description": "Verify that the tip commit of the side branch being merged is signed with a valid key, i.e. a key that has a valid uid: in the default trust model, this means the signing key has been signed by a trusted key. If the tip commit of the side branch is not signed with a valid key, the merge is aborted"
        },
        {
          "names": [
            "--no-verify-signatures"
          ],
          "description": "Do not verify that the tip commit of the side branch being merged is signed with a valid key"
        },
        {
          "names": [
            "--summary"
          ],
          "description": "Synonym to --stat ; this is deprecated and will be removed in the future"
        },
        {
          "names": [
            "--no-summary"
          ],
          "description": "Synonym to --no-stat ; this is deprecated and will be removed in the future"
        },
        {
          "names": [
            "-q",
            "--quiet"
          ],
          "description": "Operate quietly. Implies --no-progress"
        },
        {
          "names": [
            "-v",
            "--verbose"
          ],
          "description": "Be verbose"
        },
        {
          "names": [
            "--autostash"
          ],
          "description": "Automatically create a temporary stash entry before the operation begins, and apply it after the operation ends. This means that you can run the operation on a dirty worktree. However, use with care: the final stash application after a successful merge might result in non-trivial conflicts"
        },
        {
          "names": [
            "--no-autostash"
          ],
          "description": "Do not automatically create a temporary stash entry before the operation begins, and apply it after the operation ends"
        },
        {
          "names": [
            "--allow-unrelated-histories"
          ],
          "description": "By default, git merge command refuses to merge histories that do not share a common ancestor. This option can be used to override this safety when merging histories of two projects that started their lives independently. As that is a very rare occasion, no configuration variable to enable this by default exists and will not be added"
        },
        {
          "names": [
            "--all"
          ],
          "description": "Fetch all remotes"
        },
        {
          "names": [
            "-a",
            "--append"
          ],
          "description": "Append ref names and object names of fetched refs to the existing contents of .git/FETCH_HEAD"
        },
        {
          "names": [
            "--atomic"
          ],
          "description": "Use an atomic transaction to update local refs. Either all refs are updated, or on error, no refs are updated"
        },
        {
          "names": [
            "--depth"
          ],
          "description": "Limit fetching to the specified number of commits from the tip of each remote branch history",
          "args": {
            "name": "depth"
          }
        },
        {
          "names": [
            "--deepen"
          ],
          "description": "Similar to --depth, except it specifies the number of commits from the current shallow boundary instead of from the tip of each remote branch history",
          "args": {
            "name": "depth"
          }
        },
        {
          "names": [
            "--shallow-since"
          ],
          "description": "Deepen or shorten the history of a shallow repository to include all reachable commits after <date>",
          "args": {
            "name": "date"
          }
        },
        {
          "names": [
            "--shallow-exclude"
          ],
          "description": "Deepen or shorten the history of a shallow repository to exclude commits reachable from a specified remote branch or tag. This option can be specified multiple times",
          "args": {
            "name": "revision"
          }
        },
        {
          "names": [
            "--unshallow"
          ],
          "description": "If the source repository is shallow, fetch as much as possible so that the current repository has the same history as the source repository"
        },
        {
          "names": [
            "--update-shallow"
          ],
          "description": "By default when fetching from a shallow repository, git fetch refuses refs that require updating .git/shallow"
        },
        {
          "names": [
            "--negotiation-tip"
          ],
          "description": "By default, Git will report, to the server, commits reachable from all local refs to find common commits in an attempt to reduce the size of the to-be-received packfile",
          "args": {
            "name": "commit|glob",
            "generators": [
              {
                "kind": "script",
                "script": [
                  "git",
                  "--no-optional-locks",
                  "log",
                  "--oneline"
                ]
              }
            ]
          }
        },
        {
          "names": [
            "--dry-run"
          ],
          "description": "Show what would be done, without making any changes"
        },
        {
          "names": [
            "-f",
            "--force"
          ],
          "description": "This option overrides that check"
        },
        {
          "names": [
            "-k",
            "--keep"
          ],
          "description": "Keep downloaded pack"
        },
        {
          "names": [
            "-p",
            "--prune"
          ],
          "description": "Before fetching, remove any remote-tracking references that no longer exist on the remote"
        },
        {
          "names": [
            "-P",
            "--prune-tags"
          ],
          "description": "Before fetching, remove any local tags that no longer exist on the remote if --prune is enabled"
        },
        {
          "names": [
            "--no-tags"
          ],
          "description": "By default, tags that point at objects that are downloaded from the remote repository are fetched and stored locally. This option disables this automatic tag following"
        },
        {
          "names": [
            "--refmap"
          ],
          "description": "When fetching refs listed on the command line, use the specified refspec (can be given more than once) to map the refs to remote-tracking branches, instead of the values of remote.*.fetch configuration variables for the remote repository",
          "args": {
            "name": "refspec"
          }
        },
        {
          "names": [
            "-t",
            "--tags"
          ],
          "description": "By default, tags that point at objects that are downloaded from the remote repository are fetched and stored locally. This option disables this automatic tag following"
        },
        {
          "names": [
            "--recurse-submodules"
          ],
          "description": "When fetching refs listed on the command line, use the specified refspec (can be given more than once) to map the refs to remote-tracking branches, instead of the values of remote.*.fetch configuration variables for the remote repository",
          "args": {
            "name": "mode",
            "isOptional": true,
            "suggestions": [
              "yes",
              "on-demand",
              "no"
            ]
          }
        },
        {
          "names": [
            "--no-recurse-submodules"
          ],
          "description": "Disable recursive fetching of submodules (this has the same effect as using the --recurse-submodules=no option)"
        },
        {
          "names": [
            "-j",
            "--jobs"
          ],
          "description": "Number of parallel children to be used for all forms of fetching",
          "args": {
            "name": "n"
          }
        },
        {
          "names": [
            "--set-upstream"
          ],
          "description": "If the remote is fetched successfully, add upstream (tracking) reference, used by argument-less git-pull[1] and other commands"
        },
        {
          "names": [
            "--upload-pack"
          ],
          "description": "When given, and the repository to fetch from is handled by git fetch-pack, --exec=<upload-pack> is passed to the command to specify non-default path for the command run on the other end",
          "args": {
            "name": "upload-pack"
          }
        },
        {
          "names": [
            "--progress"
          ],
          "description": "Progress status is reported on the standard error stream by default when it is attached to a terminal, unless -q is specified"
        },
        {
          "names": [
            "-o",
            "--server-option"
          ],
          "description": "Transmit the given string to the server when communicating using protocol version 2. The given string must not contain a NUL or LF character",
          "args": {
            "name": "option"
          }
        },
        {
          "names": [
            "--show-forced-updates"
          ],
          "description": "By default, git checks if a branch is force-updated during fetch. This can be disabled through fetch.showForcedUpdates, but the --show-forced-updates option guarantees this check occurs"
        },
        {
          "names": [
            "--no-show-forced-updates"
          ],
          "description": "By default, git checks if a branch is force-updated during fetch. Pass --no-show-forced-updates or set fetch.showForcedUpdates to false to skip this check for performance reasons"
        },
        {
          "names": [
            "-4",
            "--ipv4"
          ],
          "description": "Use IPv4 addresses only, ignoring IPv6 addresses"
        },
        {
          "names": [
            "-6",
            "--ipv6"
          ],
          "description": "Use IPv6 addresses only, ignoring IPv4 addresses"
        }
      ],
      "args": [
        {
          "name": "remote",
          "isOptional": true,
          "generators": [
            {
              "kind": "script",
              "script": [
                "git",
                "--no-optional-locks",
                "remote",
                "-v"
              ]
            }
          ]
        },
        {
          "name": "branch",
          "isOptional": true,
          "generators": [
            {
              "kind": "script",
              "script": [
                "git",
                "--no-optional-locks",
                "branch",
                "--no-color",
                "--sort=-committerdate"
              ]
            }
          ]
        }
      ]
    },
    {
      "name": "diff",
      "description": "Show changes between commits, commit and working tree, etc",
      "options": [
        {
          "names": [
            "--staged"
          ],
          "description": "Show difference between the files in the staging area and the latest version"
        },
        {
          "names": [
            "--cached"
          ],
          "description": "Show difference between staged changes and last commit"
        },
        {
          "names": [
            "--help"
          ],
          "description": "Shows different options"
        },
        {
          "names": [
            "--numstat"
          ],
          "description": "Shows number of added and deleted lines in decimal notation"
        },
        {
          "names": [
            "--name-only"
          ],
          "description": "Show only names of changed files"
        },
        {
          "names": [
            "--shortstat"
          ],
          "description": "Output only the last line of the --stat format containing total number of modified files"
        },
        {
          "names": [
            "--stat"
          ],
          "description": "Generate a diffstat",
          "args": {
            "name": "[=< width >[,< name-width >[,< count >]]]",
            "isOptional": true
          }
        },
        {
          "names": [
            "--"
          ],
          "description": "Separates paths from options for disambiguation purposes",
          "args": {
            "name": "[< path >...]",
            "isVariadic": true
          }
        }
      ],
      "args": [
        {
          "name": "commit or file",
          "isVariadic": true,
          "isOptional": true,
          "suggestions": [
            "HEAD",
            "HEAD~<N>"
          ],
          "generators": [
            {
              "kind": "script",
              "script": [
                "git",
                "--no-optional-locks",
                "log",
                "--oneline"
              ]
            },
            {
              "kind": "script",
              "script": [
                "git",
                "--no-optional-locks",
                "branch",
                "-a",
                "--no-color",
                "--sort=-committerdate"
              ]
            }
          ]
        }
      ]
    },
    {
      "name": "reset",
      "description": "Reset current HEAD to the specified state",
      "options": [
        {
          "names": [
            "--keep"
          ],
          "description": "Safe: files which are different between the current HEAD and the given commit. Will abort if there are uncommitted changes"
        },
        {
          "names": [
            "--soft"
          ],
          "description": "Remove the last commit from the current branch, but the file changes will stay in your working tree"
        },
        {
          "names": [
            "--hard"
          ],
          "description": "⚠️WARNING: you will lose all uncommitted changes in addition to the changes introduced in the last commit"
        },
        {
          "names": [
            "--mixed"
          ],
          "description": "Keep the changes in your working tree but not on the index"
        },
        {
          "names": [
            "-N"
          ],
          "description": "Mark removed paths as intent-to-add"
        },
        {
          "names": [
            "--merge"
          ],
          "description": "Resets the index and updates the files in the working tree that are different between 'commit' and HEAD"
        },
        {
          "names": [
            "-q",
            "--quiet"
          ],
          "description": "Be quiet, only report errors"
        },
        {
          "names": [
            "--no-quiet"
          ],
          "description": "Inverse of --quiet"
        },
        {
          "names": [
            "--pathspec-from-file"
          ],
          "description": "Pathspec is passed in file <file> instead of commandline args",
          "args": {
            "name": "file",
            "suggestions": [
              "-"
            ]
          }
        },
        {
          "names": [
            "--pathspec-file-nul"
          ],
          "description": "Pathspec elements are separated with NUL character"
        },
        {
          "names": [
            "-p",
            "--patch"
          ],
          "description": "Interactively select hunks in the difference between the index and <tree-ish>"
        }
      ],
      "args": [
        {
          "isVariadic": true,
          "isOptional": true,
          "suggestions": [
            "HEAD",
            "HEAD~<N>"
          ],
          "generators": [
            {
              "kind": "script",
              "script": [
                "git",
                "--no-optional-locks",
                "diff",
                "--cached",
                "--name-only"
              ]
            },
            {
              "kind": "script",
              "script": [
                "git",
                "--no-optional-locks",
                "log",
                "--oneline"
              ]
            },
            {
              "kind": "script",
              "script": [
                "git",
                "--no-optional-locks",
                "branch",
                "-a",
                "--no-color",
                "--sort=-committerdate"
              ]
            }
          ]
        }
      ]
    },
    {
      "name": "log",
      "description": "Show commit logs",
      "options": [
        {
          "names": [
            "--follow"
          ],
          "description": "Show history of given file",
          "args": {
            "name": "file"
          }
        },
        {
          "names": [
            "-q",
            "--quiet"
          ],
          "description": "Suppress diff output"
        },
        {
          "names": [
            "--show-signature"
          ],
          "description": "Check the validity of a signed commit"
        },
        {
          "names": [
            "--source"
          ],
          "description": "Show source"
        },
        {
          "names": [
            "--oneline"
          ],
          "description": "Show each commit as a single line"
        },
        {
          "names": [
            "-p",
            "-u",
            "--patch"
          ],
          "description": "Display the full diff of each commit"
        },
        {
          "names": [
            "--stat"
          ],
          "description": "Include which files were altered and the relative number of lines that were added or deleted from each of them"
        },
        {
          "names": [
            "--grep"
          ],
          "description": "Search for commits with a commit message that matches <pattern>",
          "args": {
            "name": "pattern"
          }
        },
        {
          "names": [
            "--author"
          ],
          "description": "Search for commits by a particular author",
          "args": {
            "name": "pattern"
          }
        }
      ],
      "args": [
        {
          "name": "since",
          "description": "Commit ID, branch name, HEAD, or revision reference",
          "isOptional": true,
          "suggestions": [
            "HEAD",
            "HEAD~<N>"
          ],
          "generators": [
            {
              "kind": "script",
              "script": [
                "git",
                "--no-optional-locks",
                "log",
                "--oneline"
              ]
            }
          ]
        },
        {
          "name": "until",
          "description": "Commit ID, branch name, HEAD, or revision reference",
          "isOptional": true,
          "suggestions": [
            "HEAD",
            "HEAD~<N>"
          ],
          "generators": [
            {
              "kind": "script",
              "script": [
                "git",
                "--no-optional-locks",
                "log",
                "--oneline"
              ]
            }
          ]
        }
      ]
    },
    {
      "name": "remote",
      "description": "Manage remote repository",
      "subcommands": [
        {
          "name": "add",
          "description": "Add a remote named <name> for the repository at <url>",
          "options": [
            {
              "names": [
                "-t"
              ],
              "description": "A refspec to track only <branch> is created",
              "args": {
                "name": "branch"
              }
            },
            {
              "names": [
                "-m"
              ],
              "description": "A symbolic-ref refs/remotes/<name>/HEAD is set up to point at remote’s <master> branch",
              "args": {
                "name": "master"
              }
            },
            {
              "names": [
                "-f"
              ],
              "description": "Git fetch <name> is run immediately after the remote information is set up"
            },
            {
              "names": [
                "--tags"
              ],
              "description": "Git fetch <name> imports every tag from the remote repository"
            },
            {
              "names": [
                "--no-tags"
              ],
              "description": "Git fetch <name> does not import tags from the remote repository"
            },
            {
              "names": [
                "--mirror"
              ],
              "description": "Create fetch or push mirror",
              "args": {
                "suggestions": [
                  "fetch",
                  "push"
                ]
              }
            }
          ],
          "args": [
            {
              "name": "name"
            },
            {
              "name": "repository url"
            }
          ]
        },
        {
          "name": "set-head",
          "description": "Sets or deletes the default branch",
          "options": [
            {
              "names": [
                "--auto",
                "-a"
              ],
              "description": "The remote is queried to determine its HEAD, then the symbolic-ref refs/remotes/<name>/HEAD is set to the same branch"
            },
            {
              "names": [
                "--delete",
                "-d"
              ],
              "description": "The symbolic ref refs/remotes/<name>/HEAD is deleted"
            }
          ],
          "args": [
            {
              "name": "name",
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "git",
                    "--no-optional-locks",
                    "remote",
                    "-v"
                  ]
                }
              ]
            },
            {
              "name": "branch",
              "isOptional": true
            }
          ]
        },
        {
          "name": "set-branches",
          "description": "Changes the list of branches tracked by the named remote. This can be used to track a subset of the available remote branches after the initial setup for a remote",
          "options": [
            {
              "names": [
                "--add"
              ],
              "description": "Instead of replacing the list of currently tracked branches, adds to that list"
            }
          ],
          "args": [
            {
              "name": "name",
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "git",
                    "--no-optional-locks",
                    "remote",
                    "-v"
                  ]
                }
              ]
            },
            {
              "name": "branch",
              "isVariadic": true
            }
          ]
        },
        {
          "name": "rm",
          "aliases": [
            "remove"
          ],
          "description": "Removes given remote [name]",
          "args": [
            {
              "name": "remote",
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "git",
                    "--no-optional-locks",
                    "remote",
                    "-v"
                  ]
                }
              ]
            }
          ]
        },
        {
          "name": "rename",
          "description": "Removes given remote [name]",
          "args": [
            {
              "name": "old remote",
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "git",
                    "--no-optional-locks",
                    "remote",
                    "-v"
                  ]
                }
              ]
            },
            {
              "name": "new remote name"
            }
          ]
        },
        {
          "name": "get-url",
          "description": "Retrieves the URLs for a remote",
          "options": [
            {
              "names": [
                "--push"
              ],
              "description": "Push URLs are queried rather than fetch URLs"
            },
            {
              "names": [
                "--all"
              ],
              "description": "All URLs for the remote will be listed"
            }
          ],
          "args": [
            {
              "name": "name",
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "git",
                    "--no-optional-locks",
                    "remote",
                    "-v"
                  ]
                }
              ]
            }
          ]
        },
        {
          "name": "set-url",
          "description": "Changes the URLs for the remote",
          "options": [
            {
              "names": [
                "--push"
              ],
              "description": "Push URLs are manipulated instead of fetch URLs"
            },
            {
              "names": [
                "--add"
              ],
              "description": "Instead of changing existing URLs, new URL is added"
            },
            {
              "names": [
                "--delete"
              ],
              "description": "Instead of changing existing URLs, all URLs matching regex <url> are deleted for remote <name>"
            }
          ],
          "args": [
            {
              "name": "name",
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "git",
                    "--no-optional-locks",
                    "remote",
                    "-v"
                  ]
                }
              ]
            },
            {
              "name": "newurl"
            },
            {
              "name": "oldurl",
              "isOptional": true
            }
          ]
        },
        {
          "name": "show",
          "description": "Gives some information about the remote [name]",
          "options": [
            {
              "names": [
                "-n"
              ],
              "description": "The remote heads are not queried first with git ls-remote <name>; cached information is used instead"
            }
          ],
          "args": [
            {
              "name": "name",
              "isVariadic": true,
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "git",
                    "--no-optional-locks",
                    "remote",
                    "-v"
                  ]
                }
              ]
            }
          ]
        },
        {
          "name": "prune",
          "description": "Equivalent to git fetch --prune [name], except that no new references will be fetched",
          "options": [
            {
              "names": [
                "-n"
              ]
            },
            {
              "names": [
                "--dry-run"
              ],
              "description": "Report what branches would be pruned, but do not actually prune them"
            }
          ],
          "args": [
            {
              "name": "name",
              "isVariadic": true,
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "git",
                    "--no-optional-locks",
                    "remote",
                    "-v"
                  ]
                }
              ]
            }
          ]
        },
        {
          "name": "update",
          "description": "Fetch updates for remotes or remote groups in the repository as defined by remotes.<group>",
          "options": [
            {
              "names": [
                "-p",
                "--prune"
              ]
            }
          ],
          "args": [
            {
              "name": "group",
              "isVariadic": true,
              "isOptional": true
            },
            {
              "name": "remote",
              "isVariadic": true,
              "isOptional": true
            }
          ]
        }
      ],
      "options": [
        {
          "names": [
            "-v",
            "--verbose"
          ],
          "description": "Be a little more verbose and show remote url after name. NOTE: This must be placed between remote and subcommand"
        }
      ]
    },
    {
      "name": "fetch",
      "description": "Download objects and refs from another repository",
      "options": [
        {
          "names": [
            "--all"
          ],
          "description": "Fetch all remotes"
        },
        {
          "names": [
            "-a",
            "--append"
          ],
          "description": "Append ref names and object names of fetched refs to the existing contents of .git/FETCH_HEAD"
        },
        {
          "names": [
            "--atomic"
          ],
          "description": "Use an atomic transaction to update local refs. Either all refs are updated, or on error, no refs are updated"
        },
        {
          "names": [
            "--depth"
          ],
          "description": "Limit fetching to the specified number of commits from the tip of each remote branch history",
          "args": {
            "name": "depth"
          }
        },
        {
          "names": [
            "--deepen"
          ],
          "description": "Similar to --depth, except it specifies the number of commits from the current shallow boundary instead of from the tip of each remote branch history",
          "args": {
            "name": "depth"
          }
        },
        {
          "names": [
            "--shallow-since"
          ],
          "description": "Deepen or shorten the history of a shallow repository to include all reachable commits after <date>",
          "args": {
            "name": "date"
          }
        },
        {
          "names": [
            "--shallow-exclude"
          ],
          "description": "Deepen or shorten the history of a shallow repository to exclude commits reachable from a specified remote branch or tag. This option can be specified multiple times",
          "args": {
            "name": "revision"
          }
        },
        {
          "names": [
            "--unshallow"
          ],
          "description": "If the source repository is shallow, fetch as much as possible so that the current repository has the same history as the source repository"
        },
        {
          "names": [
            "--update-shallow"
          ],
          "description": "By default when fetching from a shallow repository, git fetch refuses refs that require updating .git/shallow"
        },
        {
          "names": [
            "--negotiation-tip"
          ],
          "description": "By default, Git will report, to the server, commits reachable from all local refs to find common commits in an attempt to reduce the size of the to-be-received packfile",
          "args": {
            "name": "commit|glob",
            "generators": [
              {
                "kind": "script",
                "script": [
                  "git",
                  "--no-optional-locks",
                  "log",
                  "--oneline"
                ]
              }
            ]
          }
        },
        {
          "names": [
            "--dry-run"
          ],
          "description": "Show what would be done, without making any changes"
        },
        {
          "names": [
            "--write-fetch-head"
          ],
          "description": "Write the list of remote refs fetched in the FETCH_HEAD file directly under $GIT_DIR. This is the default"
        },
        {
          "names": [
            "--no-write-fetch-head"
          ],
          "description": "Tells Git not to write the file"
        },
        {
          "names": [
            "-f",
            "--force"
          ],
          "description": "This option overrides that check"
        },
        {
          "names": [
            "-k",
            "--keep"
          ],
          "description": "Keep downloaded pack"
        },
        {
          "names": [
            "--multiple"
          ],
          "description": "Allow several <repository> and <group> arguments to be specified. No <refspec>s may be specified"
        },
        {
          "names": [
            "--auto-maintenance",
            "--auto-gc"
          ],
          "description": "Run git maintenance run --auto at the end to perform automatic repository maintenance if"
        },
        {
          "names": [
            "--no-auto-maintenance",
            "--no-auto-gc"
          ],
          "description": "Don't run git maintenance run --auto at the end to perform automatic repository maintenance"
        },
        {
          "names": [
            "--write-commit-graph"
          ],
          "description": "Write a commit-graph after fetching. This overrides the config setting fetch.writeCommitGraph"
        },
        {
          "names": [
            "--no-write-commit-graph"
          ],
          "description": "Don't write a commit-graph after fetching. This overrides the config setting fetch.writeCommitGraph"
        },
        {
          "names": [
            "-p",
            "--prune"
          ],
          "description": "Before fetching, remove any remote-tracking references that no longer exist on the remote"
        },
        {
          "names": [
            "-P",
            "--prune-tags"
          ],
          "description": "Before fetching, remove any local tags that no longer exist on the remote if --prune is enabled"
        },
        {
          "names": [
            "-n",
            "--no-tags"
          ],
          "description": "By default, tags that point at objects that are downloaded from the remote repository are fetched and stored locally. This option disables this automatic tag following"
        },
        {
          "names": [
            "--refmap"
          ],
          "description": "When fetching refs listed on the command line, use the specified refspec (can be given more than once) to map the refs to remote-tracking branches, instead of the values of remote.*.fetch configuration variables for the remote repository",
          "args": {
            "name": "refspec"
          }
        },
        {
          "names": [
            "-t",
            "--tags"
          ],
          "description": "By default, tags that point at objects that are downloaded from the remote repository are fetched and stored locally. This option disables this automatic tag following"
        },
        {
          "names": [
            "--recurse-submodules"
          ],
          "description": "When fetching refs listed on the command line, use the specified refspec (can be given more than once) to map the refs to remote-tracking branches, instead of the values of remote.*.fetch configuration variables for the remote repository",
          "args": {
            "name": "mode",
            "isOptional": true,
            "suggestions": [
              "yes",
              "on-demand",
              "no"
            ]
          }
        },
        {
          "names": [
            "-j",
            "--jobs"
          ],
          "description": "Number of parallel children to be used for all forms of fetching",
          "args": {
            "name": "n"
          }
        },
        {
          "names": [
            "--no-recurse-submodules"
          ],
          "description": "Disable recursive fetching of submodules (this has the same effect as using the --recurse-submodules=no option)"
        },
        {
          "names": [
            "--set-upstream"
          ],
          "description": "If the remote is fetched successfully, add upstream (tracking) reference, used by argument-less git-pull[1] and other commands"
        },
        {
          "names": [
            "--submodule-prefix"
          ],
          "description": "Prepend <path> to paths printed in informative messages such as ”Fetching submodule foo\". This option is used internally when recursing over submodules",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--recurse-submodules-default"
          ],
          "description": "This option is used internally to temporarily provide a non-negative default value for the --recurse-submodules option",
          "args": {
            "name": "mode",
            "isOptional": true,
            "suggestions": [
              "yes",
              "on-demand"
            ]
          }
        },
        {
          "names": [
            "-u",
            "--update-head-ok"
          ],
          "description": "By default git fetch refuses to update the head which corresponds to the current branch. This flag disables the check. This is purely for the internal use for git pull to communicate with git fetch, and unless you are implementing your own Porcelain you are not supposed to use it"
        },
        {
          "names": [
            "--upload-pack"
          ],
          "description": "When given, and the repository to fetch from is handled by git fetch-pack, --exec=<upload-pack> is passed to the command to specify non-default path for the command run on the other end",
          "args": {
            "name": "upload-pack"
          }
        },
        {
          "names": [
            "-q",
            "--quiet"
          ],
          "description": "Pass --quiet to git-fetch-pack and silence any other internally used git commands. Progress is not reported to the standard error stream"
        },
        {
          "names": [
            "-v",
            "--verbose"
          ],
          "description": "Be verbose"
        },
        {
          "names": [
            "--progress"
          ],
          "description": "Progress status is reported on the standard error stream by default when it is attached to a terminal, unless -q is specified"
        },
        {
          "names": [
            "-o",
            "--server-option"
          ],
          "description": "Transmit the given string to the server when communicating using protocol version 2. The given string must not contain a NUL or LF character",
          "args": {
            "name": "option"
          }
        },
        {
          "names": [
            "--show-forced-updates"
          ],
          "description": "By default, git checks if a branch is force-updated during fetch. This can be disabled through fetch.showForcedUpdates, but the --show-forced-updates option guarantees this check occurs"
        },
        {
          "names": [
            "--no-show-forced-updates"
          ],
          "description": "By default, git checks if a branch is force-updated during fetch. Pass --no-show-forced-updates or set fetch.showForcedUpdates to false to skip this check for performance reasons"
        },
        {
          "names": [
            "-4",
            "--ipv4"
          ],
          "description": "Use IPv4 addresses only, ignoring IPv6 addresses"
        },
        {
          "names": [
            "-6",
            "--ipv6"
          ],
          "description": "Use IPv6 addresses only, ignoring IPv4 addresses"
        },
        {
          "names": [
            "--stdin"
          ],
          "description": "Read refspecs, one per line, from stdin in addition to those provided as arguments. The \"tag <name>\" format is not supported"
        }
      ],
      "args": [
        {
          "name": "remote",
          "isOptional": true,
          "generators": [
            {
              "kind": "script",
              "script": [
                "git",
                "--no-optional-locks",
                "remote",
                "-v"
              ]
            }
          ]
        },
        {
          "name": "branch",
          "isOptional": true,
          "generators": [
            {
              "kind": "script",
              "script": [
                "git",
                "--no-optional-locks",
                "branch",
                "--no-color",
                "--sort=-committerdate"
              ]
            }
          ]
        },
        {
          "name": "refspec",
          "isOptional": true
        }
      ]
    },
    {
      "name": "stash",
      "description": "Temporarily stores all the modified tracked files",
      "subcommands": [
        {
          "name": "push",
          "description": "Save your local modifications to a new stash entry and roll them back to HEAD",
          "options": [
            {
              "names": [
                "-p",
                "--patch"
              ],
              "description": "Interactively select hunks from the diff between HEAD and the working tree to be stashed"
            },
            {
              "names": [
                "-k",
                "--keep-index"
              ],
              "description": "All changed already added to the index are left intact"
            },
            {
              "names": [
                "-u",
                "--include-untracked"
              ],
              "description": "All untracked files are also stashed and then cleaned up"
            },
            {
              "names": [
                "-a",
                "--all"
              ],
              "description": "All ignored and untracked files are also stashed"
            },
            {
              "names": [
                "-q",
                "--quiet"
              ],
              "description": "Quiet, suppress feedback messages"
            },
            {
              "names": [
                "-m",
                "--message"
              ],
              "description": "Use the given <msg> as the stash message",
              "args": {
                "name": "message"
              }
            },
            {
              "names": [
                "--pathspec-from-file"
              ]
            },
            {
              "names": [
                "--"
              ],
              "description": "Separates pathsec from options for disambiguation purposes"
            }
          ]
        },
        {
          "name": "show",
          "description": "Show the changes recorded in the stash entry as a diff",
          "args": [
            {
              "name": "stash",
              "isOptional": true,
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "git",
                    "--no-optional-locks",
                    "stash",
                    "list"
                  ]
                }
              ]
            }
          ]
        },
        {
          "name": "save",
          "description": "Temporarily stores all the modified tracked files",
          "options": [
            {
              "names": [
                "-p",
                "--patch"
              ],
              "description": "Interactively select hunks from the diff between HEAD and the working tree to be stashed"
            },
            {
              "names": [
                "-k",
                "--keep-index"
              ],
              "description": "All changed already added to the index are left intact"
            },
            {
              "names": [
                "-u",
                "--include-untracked"
              ],
              "description": "All untracked files are also stashed and then cleaned up"
            },
            {
              "names": [
                "-a",
                "--all"
              ],
              "description": "All ignored and untracked files are also stashed"
            },
            {
              "names": [
                "-q",
                "--quiet"
              ],
              "description": "Quiet, suppress feedback messages"
            }
          ],
          "args": [
            {
              "name": "message",
              "isOptional": true
            }
          ]
        },
        {
          "name": "pop",
          "description": "Restores the most recently stashed files",
          "options": [
            {
              "names": [
                "--index"
              ],
              "description": "Tries to reinstate not only the working tree's changes, but also the index's ones"
            },
            {
              "names": [
                "-q",
                "--quiet"
              ],
              "description": "Quiet, suppress feedback messages"
            }
          ],
          "args": [
            {
              "name": "stash",
              "isOptional": true,
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "git",
                    "--no-optional-locks",
                    "stash",
                    "list"
                  ]
                }
              ]
            }
          ]
        },
        {
          "name": "list",
          "description": "Lists all stashed changesets"
        },
        {
          "name": "drop",
          "description": "Discards the most recently stashed changeset",
          "options": [
            {
              "names": [
                "-q",
                "--quiet"
              ],
              "description": "Quiet, suppress feedback messages"
            }
          ],
          "args": [
            {
              "name": "stash",
              "isOptional": true,
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "git",
                    "--no-optional-locks",
                    "stash",
                    "list"
                  ]
                }
              ]
            }
          ]
        },
        {
          "name": "clear",
          "description": "Remove all the stash entries"
        },
        {
          "name": "apply",
          "description": "Like pop, but do not remove the state from the stash list",
          "options": [
            {
              "names": [
                "--index"
              ],
              "description": "Tries to reinstate not only the working tree's changes, but also the index's ones"
            },
            {
              "names": [
                "-q",
                "--quiet"
              ],
              "description": "Quiet, suppress feedback messages"
            }
          ],
          "args": [
            {
              "name": "stash",
              "isOptional": true,
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "git",
                    "--no-optional-locks",
                    "stash",
                    "list"
                  ]
                }
              ]
            }
          ]
        },
        {
          "name": "branch",
          "description": "Creates and checks out a new branch named",
          "args": [
            {
              "name": "branch",
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "git",
                    "--no-optional-locks",
                    "branch",
                    "--no-color",
                    "--sort=-committerdate"
                  ]
                }
              ]
            },
            {
              "name": "stash",
              "isOptional": true,
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "git",
                    "--no-optional-locks",
                    "stash",
                    "list"
                  ]
                }
              ]
            }
          ]
        },
        {
          "name": "create",
          "description": "Creates a stash entry",
          "args": [
            {
              "name": "message",
              "isOptional": true
            }
          ]
        },
        {
          "name": "store",
          "description": "Store a given stash in the stash ref, updating the stash reflog",
          "options": [
            {
              "names": [
                "-m",
                "--message"
              ],
              "description": "Use the given <msg> as the stash message",
              "args": {
                "name": "message"
              }
            },
            {
              "names": [
                "-q",
                "--quiet"
              ],
              "description": "Quiet, suppress feedback messages"
            }
          ],
          "args": [
            {
              "name": "message"
            },
            {
              "name": "commit",
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "git",
                    "--no-optional-locks",
                    "log",
                    "--oneline"
                  ]
                }
              ]
            }
          ]
        }
      ]
    },
    {
      "name": "reflog",
      "description": "Show history of events with hashes",
      "options": [
        {
          "names": [
            "--relative-date"
          ],
          "description": "Show date info"
        },
        {
          "names": [
            "--all"
          ],
          "description": "Show all refs"
        }
      ]
    },
    {
      "name": "clone",
      "description": "Clone a repository into a new directory",
      "options": [
        {
          "names": [
            "-l",
            "--local"
          ],
          "description": "Bypasses the normal git aware transport mechanism"
        },
        {
          "names": [
            "--no-hardlinks"
          ],
          "description": "Force the cloning process from a repository on a local filesystem to copy the files under the .git/objects directory instead of using hardlinks"
        },
        {
          "names": [
            "-s",
            "--shared"
          ],
          "description": "Automatically setup .git/objects/info/alternates to share the objects with the source repository"
        },
        {
          "names": [
            "--dry-run"
          ],
          "description": "Do nothing; only show what would happen"
        },
        {
          "names": [
            "--reference"
          ],
          "description": "If the reference repository is on the local machine, automatically setup",
          "args": {
            "name": "repository"
          }
        },
        {
          "names": [
            "--reference-if-able"
          ],
          "description": "If the reference repository is on the local machine, automatically setup. Non existing directory is skipped with a warning",
          "args": {
            "name": "repository"
          }
        },
        {
          "names": [
            "--dissociate"
          ],
          "description": "Borrow the objects from reference repositories specified with the --reference options only to reduce network transfer, and stop borrowing from them after a clone is made by making necessary local copies of borrowed objects"
        },
        {
          "names": [
            "-q",
            "--quiet"
          ],
          "description": "Operate quietly. Progress is not reported to the standard error stream"
        },
        {
          "names": [
            "-v",
            "--verbose"
          ],
          "description": "Run verbosely. Does not affect the reporting of progress status to the standard error stream"
        },
        {
          "names": [
            "--progress"
          ],
          "description": "Progress status is reported on the standard error stream by default when it is attached to a terminal, unless --quiet is specified. This flag forces progress status even if the standard error stream is not directed to a terminal"
        },
        {
          "names": [
            "--server-option"
          ],
          "description": "Transmit the given string to the server when communicating using protocol version 2. The given string must not contain a NUL or LF character. The server’s handling of server options, including unknown ones, is server-specific. When multiple --server-option=<option> are given, they are all sent to the other side in the order listed on the command line",
          "args": {
            "name": "option"
          }
        },
        {
          "names": [
            "-n",
            "--no-checkout"
          ],
          "description": "No checkout of HEAD is performed after the clone is complete"
        },
        {
          "names": [
            "--bare"
          ],
          "description": "Make a bare Git repository. That is, instead of creating <directory> and placing the administrative files in <directory>/.git, make the <directory> itself the $GIT_DIR. This obviously implies the --no-checkout because there is nowhere to check out the working tree. Also the branch heads at the remote are copied directly to corresponding local branch heads, without mapping them to refs/remotes/origin/. When this option is used, neither remote-tracking branches nor the related configuration variables are created"
        },
        {
          "names": [
            "--sparse"
          ],
          "description": "Initialize the sparse-checkout file so the working directory starts with only the files in the root of the repository. The sparse-checkout file can be modified to grow the working directory as needed"
        },
        {
          "names": [
            "--filter"
          ],
          "description": "Use the partial clone feature and request that the server sends a subset of reachable objects according to a given object filter. When using --filter, the supplied <filter-spec> is used for the partial clone filter. For example, --filter=blob:none will filter out all blobs (file contents) until needed by Git. Also, --filter=blob:limit=<size> will filter out all blobs of size at least <size>. For more details on filter specifications, see the --filter option in git-rev-list[1]",
          "args": {
            "name": "filter spec"
          }
        },
        {
          "names": [
            "--mirror"
          ],
          "description": "Set up a mirror of the source repository. This implies --bare. Compared to --bare, --mirror not only maps local branches of the source to local branches of the target, it maps all refs (including remote-tracking branches, notes etc.) and sets up a refspec configuration such that all these refs are overwritten by a git remote update in the target repository"
        },
        {
          "names": [
            "-o",
            "--origin"
          ],
          "description": "Instead of using the remote name origin to keep track of the upstream repository, use <name>. Overrides clone.defaultRemoteName from the config",
          "args": {
            "name": "name"
          }
        },
        {
          "names": [
            "-b",
            "--branch"
          ],
          "description": "Instead of pointing the newly created HEAD to the branch pointed to by the cloned repository’s HEAD, point to <name> branch instead. In a non-bare repository, this is the branch that will be checked out. --branch can also take tags and detaches the HEAD at that commit in the resulting repository",
          "args": {
            "name": "branch name"
          }
        },
        {
          "names": [
            "-u",
            "--upload-pack"
          ],
          "description": "When given, and the repository to clone from is accessed via ssh, this specifies a non-default path for the command run on the other end",
          "args": {
            "name": "upload pack"
          }
        },
        {
          "names": [
            "--template"
          ],
          "description": "Specify the directory from which templates will be used",
          "args": {
            "name": "template directory"
          }
        },
        {
          "names": [
            "-c",
            "--config"
          ],
          "description": "Set a configuration variable in the newly-created repository; this takes effect immediately after the repository is initialized, but before the remote history is fetched or any files checked out. The key is in the same format as expected by git-config[1] (e.g., core.eol=true). If multiple values are given for the same key, each value will be written to the config file. This makes it safe, for example, to add additional fetch refspecs to the origin remote. Due to limitations of the current implementation, some configuration variables do not take effect until after the initial fetch and checkout. Configuration variables known to not take effect are: remote.<name>.mirror and remote.<name>.tagOpt. Use the corresponding --mirror and --no-tags options instead",
          "args": {
            "name": "key=value"
          }
        },
        {
          "names": [
            "--depth"
          ],
          "description": "Create a shallow clone with a history truncated to the specified number of commits. Implies --single-branch unless --no-single-branch is given to fetch the histories near the tips of all branches. If you want to clone submodules shallowly, also pass --shallow-submodules",
          "args": {
            "name": "depth"
          }
        },
        {
          "names": [
            "--shallow-since"
          ],
          "description": "Create a shallow clone with a history after the specified time",
          "args": {
            "name": "date"
          }
        },
        {
          "names": [
            "--shallow-exclude"
          ],
          "description": "Create a shallow clone with a history, excluding commits reachable from a specified remote branch or tag. This option can be specified multiple times",
          "args": {
            "name": "revision"
          }
        },
        {
          "names": [
            "--single-branch"
          ],
          "description": "Clone only the history leading to the tip of a single branch, either specified by the --branch option or the primary branch remote’s HEAD points at. Further fetches into the resulting repository will only update the remote-tracking branch for the branch this option was used for the initial cloning. If the HEAD at the remote did not point at any branch when --single-branch clone was made, no remote-tracking branch is created"
        },
        {
          "names": [
            "--no-single-branch"
          ],
          "description": "Do not clone only the history leading to the tip of a single branch, either specified by the --branch option or the primary branch remote’s HEAD points at. Further fetches into the resulting repository will only update the remote-tracking branch for the branch this option was used for the initial cloning. If the HEAD at the remote did not point at any branch when --single-branch clone was made, no remote-tracking branch is created"
        },
        {
          "names": [
            "--no-tags"
          ],
          "description": "Don’t clone any tags, and set remote.<remote>.tagOpt=--no-tags in the config, ensuring that future git pull and git fetch operations won’t follow any tags. Subsequent explicit tag fetches will still work, (see git-fetch[1])"
        },
        {
          "names": [
            "--recurse-submodules"
          ],
          "description": "After the clone is created, initialize and clone submodules within based on the provided pathspec. If no pathspec is provided, all submodules are initialized and cloned. This option can be given multiple times for pathspecs consisting of multiple entries",
          "args": {
            "name": "pathspec",
            "isOptional": true
          }
        },
        {
          "names": [
            "--shallow-submodules"
          ],
          "description": "All submodules which are cloned will be shallow with a depth of 1"
        },
        {
          "names": [
            "--no-shallow-submodules"
          ],
          "description": "Disable --shallow-submodules"
        },
        {
          "names": [
            "--remote-submodules"
          ],
          "description": "All submodules which are cloned will use the status of the submodule’s remote-tracking branch to update the submodule, rather than the superproject’s recorded SHA-1. Equivalent to passing --remote to git submodule update"
        },
        {
          "names": [
            "--no-remote-submodules"
          ],
          "description": "Disable --remote-submodules"
        },
        {
          "names": [
            "-j",
            "--jobs"
          ],
          "description": "The number of submodules fetched at the same time. Defaults to the submodule.fetchJobs option",
          "args": {
            "name": "n",
            "isOptional": true
          }
        },
        {
          "names": [
            "--separate-git-dir"
          ],
          "description": "Instead of placing the cloned repository where it is supposed to be, place the cloned repository at the specified directory, then make a filesystem-agnostic Git symbolic link to there. The result is Git repository can be separated from working tree",
          "args": {
            "name": "git dir"
          }
        }
      ],
      "args": [
        {
          "name": "repository",
          "description": "Git library to be cloned"
        },
        {
          "name": "directory",
          "description": "Specify the new directory name or target folder",
          "isOptional": true
        }
      ]
    },
    {
      "name": "init",
      "description": "Create an empty Git repository or reinitialize an existing one",
      "options": [
        {
          "names": [
            "-q",
            "--quiet"
          ],
          "description": "Only print error and warning messages"
        },
        {
          "names": [
            "--bare"
          ],
          "description": "Create a bare repository"
        },
        {
          "names": [
            "--object-format"
          ],
          "description": "Specify the given object format",
          "args": {
            "name": "format",
            "suggestions": [
              "sha1",
              "sha256"
            ]
          }
        },
        {
          "names": [
            "--template"
          ],
          "description": "Specify the directory from which templates will be used",
          "args": {
            "name": "template_directory"
          }
        },
        {
          "names": [
            "--separate-git-dir"
          ],
          "description": "Instead of initializing the repository as a directory to either $GIT_DIR or ./.git/, create a text file there containing the path to the actual repository. This file acts as filesystem-agnostic Git symbolic link to the repository",
          "args": {
            "name": "git dir"
          }
        },
        {
          "names": [
            "-b",
            "--initial-branch"
          ],
          "description": "Initial branch for new repo",
          "args": {
            "name": "branch-name",
            "isOptional": true
          }
        },
        {
          "names": [
            "--shared"
          ],
          "description": "Specify that the Git repository is to be shared amongst several users. This allows users belonging to the same group to push into that repository",
          "args": {
            "isOptional": true,
            "suggestions": [
              "false",
              "true",
              "umask",
              "group",
              "all",
              "world",
              "everybody",
              "0xxx"
            ]
          }
        }
      ],
      "args": [
        {
          "name": "directory",
          "isOptional": true
        }
      ]
    },
    {
      "name": "mv",
      "description": "Move or rename a file, a directory, or a symlink",
      "options": [
        {
          "names": [
            "-f",
            "--force"
          ],
          "description": "Force renaming or moving of a file even if the target exists"
        },
        {
          "names": [
            "-k"
          ],
          "description": "Skip move or rename actions which would lead to an error condition"
        },
        {
          "names": [
            "-n",
            "--dry-run"
          ],
          "description": "Do nothing; only show what would happen"
        },
        {
          "names": [
            "-v",
            "--verbose"
          ],
          "description": "Report the names of files as they are moved"
        }
      ],
      "args": [
        {
          "name": "source",
          "description": "File to move"
        },
        {
          "name": "destination",
          "description": "Location to move to"
        }
      ]
    },
    {
      "name": "rm",
      "description": "Remove files from the working tree and from the index",
      "options": [
        {
          "names": [
            "--"
          ],
          "description": "Used to separate command-line options from the list of files"
        },
        {
          "names": [
            "--cached"
          ],
          "description": "Only remove from the index"
        },
        {
          "names": [
            "-f",
            "--force"
          ],
          "description": "Override the up-to-date check"
        },
        {
          "names": [
            "-n",
            "--dry-run"
          ],
          "description": "Don’t actually remove any file(s). Instead, just show if they exist in the index and would otherwise be removed by the command"
        },
        {
          "names": [
            "-r"
          ],
          "description": "Allow recursive removal"
        }
      ],
      "args": [
        {
          "isVariadic": true,
          "suggestions": [
            "."
          ],
          "generators": [
            {
              "kind": "script",
              "script": [
                "git",
                "--no-optional-locks",
                "status",
                "--short"
              ]
            }
          ]
        }
      ]
    },
    {
      "name": "bisect",
      "description": "Use binary search to find the commit that introduced a bug",
      "subcommands": [
        {
          "name": "start",
          "description": "Reset bisect state and start bisection",
          "options": [
            {
              "names": [
                "--term-new"
              ],
              "description": "Specify the alias to mark commits as new during the bisect process",
              "args": {
                "name": "term",
                "description": "Specifying: fixed, would require using git bisect fixed instead of git bisect new"
              }
            },
            {
              "names": [
                "--term-bad"
              ],
              "description": "Specify the alias to mark commits as bad during the bisect process",
              "args": {
                "name": "term",
                "description": "Specifying: broken, would require using git bisect broken instead of git bisect bad"
              }
            },
            {
              "names": [
                "--term-good"
              ],
              "description": "Specify the alias to mark commits as good during the bisect process",
              "args": {
                "name": "term",
                "description": "Specifying: fixed, would require using git bisect fixed instead of git bisect good"
              }
            },
            {
              "names": [
                "--term-old"
              ],
              "description": "Specify the alias to mark commits as old during the bisect process",
              "args": {
                "name": "term",
                "description": "Specifying: broken, would require using git bisect broken instead of git bisect old"
              }
            },
            {
              "names": [
                "--no-checkout"
              ],
              "description": "Do not checkout the new working tree at each iteration of the bisection process. Instead just update a special reference named BISECT_HEAD to make it point to the commit that should be tested"
            },
            {
              "names": [
                "--first-parent"
              ],
              "description": "Follow only the first parent commit upon seeing a merge commit. In detecting regressions introduced through the merging of a branch, the merge commit will be identified as introduction of the bug and its ancestors will be ignored"
            },
            {
              "names": [
                "--"
              ],
              "description": "Stop taking subcommand arguments and options. Starts taking paths to bisect"
            }
          ],
          "args": [
            {
              "name": "bad",
              "isOptional": true,
              "suggestions": [
                "HEAD",
                "HEAD~<N>"
              ],
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "git",
                    "rev-list",
                    "--all",
                    "--oneline"
                  ]
                }
              ]
            },
            {
              "name": "good",
              "isVariadic": true,
              "isOptional": true,
              "suggestions": [
                "HEAD",
                "HEAD~<N>"
              ],
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "git",
                    "rev-list",
                    "--all",
                    "--oneline"
                  ]
                },
                {
                  "kind": "script",
                  "script": [
                    "git",
                    "rev-list",
                    "--all",
                    "--oneline"
                  ]
                }
              ]
            }
          ]
        },
        {
          "name": "bad",
          "description": "Mark commits as bad",
          "args": [
            {
              "name": "rev",
              "isOptional": true,
              "suggestions": [
                "HEAD",
                "HEAD~<N>"
              ],
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "git",
                    "rev-list",
                    "--all",
                    "--oneline"
                  ]
                }
              ]
            }
          ]
        },
        {
          "name": "new",
          "description": "Mark commits as new",
          "args": [
            {
              "name": "rev",
              "isOptional": true,
              "suggestions": [
                "HEAD",
                "HEAD~<N>"
              ],
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "git",
                    "rev-list",
                    "--all",
                    "--oneline"
                  ]
                }
              ]
            }
          ]
        },
        {
          "name": "old",
          "description": "Mark commits as old",
          "args": [
            {
              "name": "rev",
              "isVariadic": true,
              "isOptional": true,
              "suggestions": [
                "HEAD",
                "HEAD~<N>"
              ],
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "git",
                    "rev-list",
                    "--all",
                    "--oneline"
                  ]
                }
              ]
            }
          ]
        },
        {
          "name": "good",
          "description": "Mark commits as good",
          "args": [
            {
              "name": "rev",
              "isVariadic": true,
              "isOptional": true,
              "suggestions": [
                "HEAD",
                "HEAD~<N>"
              ],
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "git",
                    "rev-list",
                    "--all",
                    "--oneline"
                  ]
                }
              ]
            }
          ]
        },
        {
          "name": "next",
          "description": "Find next bisection to test and check it out"
        },
        {
          "name": "terms",
          "description": "Show the terms used for old and new commits (default: bad, good)",
          "options": [
            {
              "names": [
                "--term-old"
              ],
              "description": "You can get just the old (respectively new) term"
            },
            {
              "names": [
                "--term-good"
              ],
              "description": "You can get just the old (respectively new) term"
            }
          ]
        },
        {
          "name": "skip",
          "description": "Mark <rev>... untestable revisions",
          "args": [
            {
              "name": "rev | range",
              "isVariadic": true,
              "isOptional": true,
              "suggestions": [
                "HEAD",
                "HEAD~<N>"
              ],
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "git",
                    "rev-list",
                    "--all",
                    "--oneline"
                  ]
                }
              ]
            }
          ]
        },
        {
          "name": "reset",
          "description": "Finish bisection search and go back to commit",
          "args": [
            {
              "name": "commit",
              "isOptional": true,
              "suggestions": [
                "HEAD",
                "HEAD~<N>"
              ],
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "git",
                    "--no-optional-locks",
                    "log",
                    "--oneline"
                  ]
                }
              ]
            }
          ]
        },
        {
          "name": "visualize",
          "aliases": [
            "view"
          ],
          "description": "See the currently remaining suspects in gitk"
        },
        {
          "name": "replay",
          "description": "Replay bisection log",
          "args": [
            {
              "name": "logfile"
            }
          ]
        },
        {
          "name": "log",
          "description": "Show bisect log"
        },
        {
          "name": "run",
          "description": "Use <cmd>... to automatically bisect",
          "args": [
            {
              "name": "cmd",
              "isVariadic": true
            }
          ]
        },
        {
          "name": "help",
          "args": [
            {
              "name": "Get help text"
            }
          ]
        }
      ],
      "args": [
        {
          "name": "paths"
        }
      ]
    },
    {
      "name": "grep",
      "description": "Print lines matching a pattern"
    },
    {
      "name": "show",
      "description": "Show various types of objects"
    },
    {
      "name": "branch",
      "description": "List, create, or delete branches",
      "options": [
        {
          "names": [
            "-a",
            "--all"
          ],
          "description": "List both remote-tracking and local branches"
        },
        {
          "names": [
            "-d",
            "--delete"
          ],
          "description": "Delete fully merged branch",
          "args": {
            "isVariadic": true
          }
        },
        {
          "names": [
            "-D"
          ],
          "description": "Delete branch (even if not merged)",
          "args": {
            "isVariadic": true
          }
        },
        {
          "names": [
            "-m",
            "--move"
          ],
          "description": "Move/rename a branch and its reflog",
          "args": {
            "generators": [
              {
                "kind": "script",
                "script": [
                  "git",
                  "--no-optional-locks",
                  "branch",
                  "--no-color",
                  "--sort=-committerdate"
                ]
              }
            ]
          }
        },
        {
          "names": [
            "-M"
          ],
          "description": "Move/rename a branch, even if target exists",
          "args": {
            "generators": [
              {
                "kind": "script",
                "script": [
                  "git",
                  "--no-optional-locks",
                  "branch",
                  "--no-color",
                  "--sort=-committerdate"
                ]
              }
            ]
          }
        },
        {
          "names": [
            "-c",
            "--copy"
          ],
          "description": "Copy a branch and its reflog"
        },
        {
          "names": [
            "-C"
          ],
          "description": "Copy a branch, even if target exists"
        },
        {
          "names": [
            "-l",
            "--list"
          ],
          "description": "List branch names"
        },
        {
          "names": [
            "--create-reflog"
          ],
          "description": "Create the branch's reflog"
        },
        {
          "names": [
            "--edit-description"
          ],
          "description": "Edit the description for the branch",
          "args": {
            "generators": [
              {
                "kind": "script",
                "script": [
                  "git",
                  "--no-optional-locks",
                  "branch",
                  "--no-color",
                  "--sort=-committerdate"
                ]
              }
            ]
          }
        },
        {
          "names": [
            "-f",
            "--force"
          ],
          "description": "Force creation, move/rename, deletion"
        },
        {
          "names": [
            "--merged"
          ],
          "description": "Print only branches that are merged",
          "args": {
            "name": "commit"
          }
        },
        {
          "names": [
            "--no-merged"
          ],
          "description": "Print only branches that are not merged",
          "args": {
            "name": "commit"
          }
        },
        {
          "names": [
            "--column"
          ],
          "description": "List branches in columns [=<style>]"
        },
        {
          "names": [
            "--no-column"
          ],
          "description": "Doesn't display branch listing in columns"
        },
        {
          "names": [
            "--sort"
          ],
          "description": "Field name to sort on",
          "args": {
            "name": "key"
          }
        },
        {
          "names": [
            "--points-at"
          ],
          "description": "Print only branches of the object",
          "args": {
            "name": "object"
          }
        },
        {
          "names": [
            "-i",
            "--ignore-case"
          ],
          "description": "Sorting and filtering are case insensitive"
        },
        {
          "names": [
            "--format"
          ],
          "description": "Format to use for the output",
          "args": {
            "name": "format"
          }
        },
        {
          "names": [
            "-r",
            "--remotes"
          ],
          "description": "Lists or deletes (if used with -d) the remote-tracking branches"
        },
        {
          "names": [
            "--show-current"
          ],
          "description": "Prints the name of the current branch"
        },
        {
          "names": [
            "-v",
            "--verbose"
          ],
          "description": "Shows sha1 and commit subject line for each head, along with relationship to upstream branch when in list mode. If given twice, prints the path of the linked worktree and the name of the upstream branch"
        },
        {
          "names": [
            "-q",
            "--quiet"
          ],
          "description": "Suppress non-error messages"
        },
        {
          "names": [
            "--abbrev"
          ],
          "description": "Shows the shortest prefix that is at least <n> hexdigits long that uniquely refers the object",
          "args": {
            "name": "Number"
          }
        },
        {
          "names": [
            "--no-abbrev"
          ],
          "description": "Displays the full sha1s in the output listing"
        },
        {
          "names": [
            "-t",
            "--track"
          ],
          "description": "When creating a new branch, set up 'upstream' configuration",
          "args": {
            "name": "branch",
            "generators": [
              {
                "kind": "script",
                "script": [
                  "git",
                  "--no-optional-locks",
                  "branch",
                  "--no-color",
                  "--sort=-committerdate"
                ]
              }
            ]
          }
        },
        {
          "names": [
            "--no-track"
          ],
          "description": "Do not set up 'upstream' configuration, even if the branch.autoSetupMerge configuration variable is true",
          "args": {
            "generators": [
              {
                "kind": "script",
                "script": [
                  "git",
                  "--no-optional-locks",
                  "branch",
                  "--no-color",
                  "--sort=-committerdate"
                ]
              }
            ]
          }
        },
        {
          "names": [
            "-u",
            "--set-upstream-to"
          ],
          "description": "Sets branch to upstream provided",
          "args": {
            "name": "upstream",
            "isOptional": true,
            "generators": [
              {
                "kind": "script",
                "script": [
                  "git",
                  "--no-optional-locks",
                  "branch",
                  "--no-color",
                  "--sort=-committerdate"
                ]
              }
            ]
          }
        },
        {
          "names": [
            "--unset-upstream"
          ],
          "description": "Removes the upstream information",
          "args": {
            "name": "upstream",
            "isOptional": true,
            "generators": [
              {
                "kind": "script",
                "script": [
                  "git",
                  "--no-optional-locks",
                  "branch",
                  "--no-color",
                  "--sort=-committerdate"
                ]
              }
            ]
          }
        },
        {
          "names": [
            "--contains"
          ],
          "description": "Only lists branches which contain the specified commit",
          "args": {
            "name": "commit",
            "isOptional": true,
            "generators": [
              {
                "kind": "script",
                "script": [
                  "git",
                  "--no-optional-locks",
                  "log",
                  "--oneline"
                ]
              }
            ]
          }
        },
        {
          "names": [
            "--no-contains"
          ],
          "description": "Only lists branches which don't contain the specified commit",
          "args": {
            "name": "commit",
            "isOptional": true,
            "generators": [
              {
                "kind": "script",
                "script": [
                  "git",
                  "--no-optional-locks",
                  "log",
                  "--oneline"
                ]
              }
            ]
          }
        },
        {
          "names": [
            "--color"
          ],
          "description": "Color branches to highlight current, local, and remote-tracking branches",
          "args": {
            "name": "when",
            "isOptional": true,
            "suggestions": [
              "always",
              "never",
              "auto"
            ]
          }
        },
        {
          "names": [
            "--no-color"
          ],
          "description": "Turns off branch colors"
        }
      ]
    },
    {
      "name": "checkout",
      "description": "Switch branches or restore working tree files",
      "options": [
        {
          "names": [
            "-q",
            "--quiet"
          ],
          "description": "Quiet, suppress feedback messages"
        },
        {
          "names": [
            "--progress"
          ],
          "description": "Progress status is reported on the standard error stream by default when it is attached to a terminal, unless --quiet is specified. This flag enables progress reporting even if not attached to a terminal, regardless of --quiet"
        },
        {
          "names": [
            "--no-progress"
          ],
          "description": "Disable progress status reporting"
        },
        {
          "names": [
            "-f",
            "--force"
          ],
          "description": "When switching branches, proceed even if the index or the working tree differs from HEAD. This is used to throw away local changes"
        },
        {
          "names": [
            "-2",
            "--ours"
          ],
          "description": "When checking out paths from the index, check out stage #2 (ours) for unmerged paths"
        },
        {
          "names": [
            "-3",
            "--theirs"
          ],
          "description": "When checking out paths from the index, check out stage #3 (theirs) for unmerged paths"
        },
        {
          "names": [
            "-b"
          ],
          "description": "Create a new branch named <new_branch> and start it at <start_point>; see git-branch[1] for details",
          "args": {
            "name": "New Branch"
          }
        },
        {
          "names": [
            "-B"
          ],
          "description": "Creates the branch <new_branch> and start it at <start_point>; if it already exists, then reset it to <start_point>. This is equivalent to running 'git branch' with '-f'; see git-branch[1] for details",
          "args": {
            "name": "New Branch"
          }
        },
        {
          "names": [
            "-t",
            "--track"
          ],
          "description": "When creating a new branch, set up 'upstream' configuration"
        },
        {
          "names": [
            "--no-track"
          ],
          "description": "Do not set up 'upstream' configuration, even if the branch.autoSetupMerge configuration variable is true"
        },
        {
          "names": [
            "--guess"
          ],
          "description": "If <branch> is not found but there does exist a tracking branch in exactly one remote (call it <remote>) with a matching name, treat as equivalent to $ git checkout -b <branch> --track <remote>/<branch>"
        },
        {
          "names": [
            "--no-guess"
          ],
          "description": "Disable --guess"
        },
        {
          "names": [
            "-l"
          ],
          "description": "Create the new branch’s reflog; see git-branch[1] for details"
        },
        {
          "names": [
            "-d",
            "--detach"
          ],
          "description": "Rather than checking out a branch to work on it, check out a commit for inspection and discardable experiments. This is the default behavior of git checkout <commit> when <commit> is not a branch name"
        },
        {
          "names": [
            "--orphan"
          ],
          "description": "Create a new orphan branch, named <new_branch>, started from <start_point> and switch to it",
          "args": {
            "name": "New Branch"
          }
        },
        {
          "names": [
            "--ignore-skip-worktree-bits"
          ],
          "description": "In sparse checkout mode, git checkout -- <paths> would update only entries matched by <paths> and sparse patterns in $GIT_DIR/info/sparse-checkout. This option ignores the sparse patterns and adds back any files in <paths>"
        },
        {
          "names": [
            "-m",
            "--merge"
          ],
          "description": "When switching branches, if you have local modifications to one or more files that are different between the current branch and the branch to which you are switching, the command refuses to switch branches in order to preserve your modifications in context"
        },
        {
          "names": [
            "--conflict"
          ],
          "description": "The same as --merge option above, but changes the way the conflicting hunks are presented, overriding the merge.conflictStyle configuration variable. Possible values are 'merge' (default) and 'diff3' (in addition to what is shown by 'merge' style, shows the original contents)",
          "args": {
            "isOptional": true,
            "suggestions": [
              "merge",
              "diff3"
            ]
          }
        },
        {
          "names": [
            "-p",
            "--patch"
          ],
          "description": "Interactively select hunks in the difference between the <tree-ish> (or the index, if unspecified) and the working tree"
        },
        {
          "names": [
            "--ignore-other-worktrees"
          ],
          "description": "Git checkout refuses when the wanted ref is already checked out by another worktree. This option makes it check the ref out anyway. In other words, the ref can be held by more than one worktree"
        },
        {
          "names": [
            "--overwrite-ignore"
          ],
          "description": "Silently overwrite ignored files when switching branches. This is the default behavior"
        },
        {
          "names": [
            "--no-overwrite-ignore"
          ],
          "description": "Use --no-overwrite-ignore to abort the operation when the new branch contains ignored files"
        },
        {
          "names": [
            "--recurse-submodules"
          ],
          "description": "Using --recurse-submodules will update the content of all active submodules according to the commit recorded in the superproject. If local modifications in a submodule would be overwritten the checkout will fail unless -f is used. If nothing (or --no-recurse-submodules) is used, submodules working trees will not be updated. Just like git-submodule[1], this will detach HEAD of the submodule"
        },
        {
          "names": [
            "--no-recurse-submodules"
          ],
          "description": "Submodules working trees will not be updated"
        },
        {
          "names": [
            "--overlay"
          ],
          "description": "In the default overlay mode, git checkout never removes files from the index or the working tree"
        },
        {
          "names": [
            "--no-overlay"
          ],
          "description": "When specifying --no-overlay, files that appear in the index and working tree, but not in <tree-ish> are removed, to make them match <tree-ish> exactly"
        },
        {
          "names": [
            "--pathspec-from-file"
          ],
          "description": "Pathspec is passed in <file> instead of commandline args",
          "args": {
            "name": "file"
          }
        },
        {
          "names": [
            "--pathspec-file-nul"
          ],
          "description": "Only meaningful with --pathspec-from-file"
        }
      ],
      "args": [
        {
          "name": "branch, file, tag or commit",
          "description": "Branch, file, tag or commit to switch to",
          "isOptional": true,
          "suggestions": [
            "-",
            "--"
          ],
          "generators": [
            {
              "kind": "script",
              "script": [
                "git",
                "--no-optional-locks",
                "branch",
                "-a",
                "--no-color",
                "--sort=-committerdate"
              ]
            },
            {
              "kind": "script",
              "script": [
                "git",
                "--no-optional-locks",
                "tag",
                "--list",
                "--sort=-committerdate"
              ]
            }
          ]
        },
        {
          "name": "pathspec",
          "description": "Limits the paths affected by the operation",
          "isVariadic": true,
          "isOptional": true
        }
      ]
    },
    {
      "name": "cherry-pick",
      "description": "Apply the changes introduced by some existing commits",
      "options": [
        {
          "names": [
            "--continue"
          ],
          "description": "Continue the operation in progress using the information in .git/sequencer"
        },
        {
          "names": [
            "--skip"
          ],
          "description": "Skip the current commit and continue with the rest of the sequence"
        },
        {
          "names": [
            "--quit"
          ],
          "description": "Forget about the current operation in progress"
        },
        {
          "names": [
            "--abort"
          ],
          "description": "Cancel the operation and return to the pre-sequence state"
        },
        {
          "names": [
            "-e",
            "--edit"
          ],
          "description": "With this option, git cherry-pick will let you edit the commit message prior to committing"
        },
        {
          "names": [
            "--cleanup"
          ],
          "description": "This option determines how the commit message will be cleaned up before being passed on to the commit machinery",
          "args": {
            "name": "mode",
            "description": "Determines how the supplied commit messaged should be cleaned up before committing",
            "suggestions": [
              "strip",
              "whitespace",
              "verbatim",
              "scissors",
              "default"
            ]
          }
        },
        {
          "names": [
            "-x"
          ],
          "description": "When recording the commit, append a line that says \"(cherry picked from commit ...)\" to the original commit message in order to indicate which commit this change was cherry-picked from"
        },
        {
          "names": [
            "-m",
            "--mainline"
          ],
          "description": "Specifies the parent number (starting from 1) of the mainline and allows cherry-pick to replay the change relative to the specified parent",
          "args": {
            "name": "parent-number"
          }
        },
        {
          "names": [
            "-n",
            "--no-commit"
          ],
          "description": "Applies changes necessary to cherry-pick each named commit to your working tree and the index without making any commit"
        },
        {
          "names": [
            "-s",
            "--signoff"
          ],
          "description": "Add a Signed-off-by trailer at the end of the commit message"
        },
        {
          "names": [
            "-S",
            "--gpg-sign"
          ],
          "description": "GPG-sign commits",
          "args": {
            "name": "keyid",
            "description": "Must be stuck to the option without a space",
            "isOptional": true
          }
        },
        {
          "names": [
            "--no-gpg-sign"
          ],
          "description": "Useful to countermand both commit.gpgSign configuration variable, and earlier --gpg-sign"
        },
        {
          "names": [
            "--ff"
          ],
          "description": "If the current HEAD is the same as the parent of the cherry-pick'ed commit, the a fast forward to this commit will be performed"
        },
        {
          "names": [
            "--allow-empty"
          ],
          "description": "Allow empty commits to be preserved automatically in a cherry-pick"
        },
        {
          "names": [
            "--allow-empty-message"
          ],
          "description": "Allow commits with empty messages to be cherry picked"
        },
        {
          "names": [
            "--keep-redundant-commits"
          ],
          "description": "Creates an empty commit object. Implies --allow-empty"
        },
        {
          "names": [
            "--strategy"
          ],
          "description": "Use the given merge strategy. Should only be used once",
          "args": {
            "name": "strategy",
            "suggestions": [
              "resolve",
              "recursive",
              "octopus",
              "ours",
              "subtree"
            ]
          }
        },
        {
          "names": [
            "-X",
            "--strategy-option"
          ],
          "description": "Pass the merge strategy-specific option through to the merge strategy",
          "args": {
            "name": "option",
            "suggestions": [
              "ours",
              "theirs",
              "patience",
              "diff-algorithm",
              "diff-algorithm=patience",
              "diff-algorithm=minimal",
              "diff-algorithm=histogram",
              "diff-algorithm=myers",
              "ignore-space-change",
              "ignore-all-space",
              "ignore-space-at-eol",
              "ignore-cr-at-eol",
              "renormalize",
              "no-renormalize",
              "no-renames",
              "find-renames",
              "subtree"
            ]
          }
        },
        {
          "names": [
            "--rerere-autoupdate"
          ],
          "description": "Allow the rerere mechanism to update the index with the result of auto-conflict resolution if possible"
        },
        {
          "names": [
            "--no-rerere-autoupdate"
          ],
          "description": "Do not allow the rerere mechanism to update the index with the result of auto-conflict resolution if possible"
        }
      ],
      "args": [
        {
          "name": "commit",
          "description": "Commits to cherry-pick",
          "isVariadic": true,
          "generators": [
            {
              "kind": "script",
              "script": [
                "git",
                "--no-optional-locks",
                "log",
                "--oneline"
              ]
            }
          ]
        }
      ]
    },
    {
      "name": "submodule",
      "description": "Initialize, update or inspect submodules",
      "subcommands": [
        {
          "name": "add",
          "description": "Add the given repository as a submodule at the given path to the changeset to be committed next to the current project",
          "options": [
            {
              "names": [
                "-b"
              ],
              "description": "Branch of repository to add as submodule",
              "args": {
                "name": "branch"
              }
            },
            {
              "names": [
                "-f",
                "--force"
              ],
              "description": "Allow adding an otherwise ignored submodule path"
            },
            {
              "names": [
                "--name"
              ],
              "description": "It sets the submodule’s name to the given string instead of defaulting to its path",
              "args": {
                "name": "name",
                "description": "Directory name"
              }
            },
            {
              "names": [
                "--reference"
              ],
              "description": "Remote repository to be cloned",
              "args": {
                "name": "repository",
                "description": "Remote repository to be cloned"
              }
            },
            {
              "names": [
                "--depth"
              ],
              "description": "Create a shallow clone with a history truncated to the specified number of revisions",
              "args": {
                "name": "depth",
                "description": "Specified number of revisions"
              }
            },
            {
              "names": [
                "--"
              ],
              "description": "End of subcommand options"
            }
          ],
          "args": [
            {
              "name": "repository"
            },
            {
              "name": "path",
              "isOptional": true
            }
          ]
        },
        {
          "name": "status",
          "description": "Show the status of the submodules",
          "options": [
            {
              "names": [
                "--cached"
              ],
              "description": "Will instead print the SHA-1 recorded in the superproject for each submodule"
            },
            {
              "names": [
                "--recursive"
              ],
              "description": "Will recurse into nested submodules, and show their status as well"
            },
            {
              "names": [
                "--"
              ],
              "description": "End of subcommand options"
            }
          ],
          "args": [
            {
              "name": "path",
              "isVariadic": true,
              "isOptional": true
            }
          ]
        },
        {
          "name": "init",
          "description": "Initialize the submodules recorded in the index",
          "options": [
            {
              "names": [
                "--"
              ],
              "description": "End of subcommand options"
            }
          ],
          "args": [
            {
              "name": "path",
              "isVariadic": true,
              "isOptional": true
            }
          ]
        },
        {
          "name": "deinit",
          "description": "Unregister the given submodules",
          "options": [
            {
              "names": [
                "-f",
                "--force"
              ],
              "description": "The submodule’s working tree will be removed even if it contains local modifications"
            },
            {
              "names": [
                "--all"
              ],
              "description": "Unregister all submodules in the working tree"
            },
            {
              "names": [
                "--"
              ],
              "description": "End of subcommand options"
            }
          ],
          "args": [
            {
              "name": "path",
              "isVariadic": true,
              "isOptional": true
            }
          ]
        },
        {
          "name": "update",
          "description": "Update the registered submodules to match what the superproject expects by cloning missing submodules, fetching missing commits in submodules and updating the working tree of the submodules",
          "options": [
            {
              "names": [
                "--init"
              ],
              "description": "Initialize all submodules for which 'git submodule init' has not been called so far before updating"
            },
            {
              "names": [
                "--remote"
              ],
              "description": "Instead of using the superproject’s recorded SHA-1 to update the submodule, use the status of the submodule’s remote-tracking branch"
            },
            {
              "names": [
                "-N",
                "--no-fetch"
              ],
              "description": "Don’t fetch new objects from the remote site"
            },
            {
              "names": [
                "--no-recommend-shallow"
              ],
              "description": "Ignore the suggestions"
            },
            {
              "names": [
                "--recommend-shallow"
              ],
              "description": "The initial clone of a submodule will use the recommended submodule.<name>.shallow as provided by the .gitmodules file"
            },
            {
              "names": [
                "-f",
                "--force"
              ],
              "description": "Throw away local changes in submodules when switching to a different commit; and always run a checkout operation in the submodule, even if the commit listed in the index of the containing repository matches the commit checked out in the submodule"
            },
            {
              "names": [
                "--checkout"
              ],
              "description": "The commit recorded in the superproject will be checked out in the submodule on a detached HEAD"
            },
            {
              "names": [
                "--rebase"
              ],
              "description": "The current branch of the submodule will be rebased onto the commit recorded in the superproject"
            },
            {
              "names": [
                "--merge"
              ],
              "description": "The commit recorded in the superproject will be merged into the current branch in the submodule"
            },
            {
              "names": [
                "--reference"
              ],
              "description": "Remote repository",
              "args": {
                "name": "repository"
              }
            },
            {
              "names": [
                "--depth"
              ],
              "description": "Create a shallow clone with a history truncated to the specified number of revisions",
              "args": {
                "name": "depth"
              }
            },
            {
              "names": [
                "--recursive"
              ],
              "description": "Traverse submodules recursively"
            },
            {
              "names": [
                "--jobs"
              ],
              "description": "Clone new submodules in parallel with as many jobs",
              "args": {
                "name": "n"
              }
            },
            {
              "names": [
                "--single-branch"
              ],
              "description": "Clone only one branch during update: HEAD or one specified by --branch"
            },
            {
              "names": [
                "--no-single-branch"
              ],
              "description": "Don't clone only one branch during update: HEAD or one specified by --branch"
            },
            {
              "names": [
                "--"
              ],
              "description": "End of subcommand options"
            }
          ],
          "args": [
            {
              "name": "path",
              "isVariadic": true,
              "isOptional": true
            }
          ]
        },
        {
          "name": "set-branch",
          "description": "Sets the default remote tracking branch for the submodule",
          "options": [
            {
              "names": [
                "-b",
                "--branch"
              ],
              "description": "Branch of repository to add as submodule",
              "args": {
                "name": "branch",
                "description": "Remote branch to be specified"
              }
            },
            {
              "names": [
                "-d",
                "--default"
              ],
              "description": "Removes the submodule.<name>.branch configuration key, which causes the tracking branch to default to the remote HEAD"
            },
            {
              "names": [
                "--"
              ],
              "description": "End of subcommand options"
            }
          ],
          "args": [
            {
              "name": "path",
              "description": "Path to submodule"
            }
          ]
        },
        {
          "name": "set-url",
          "description": "Sets the URL of the specified submodule to <newurl>",
          "options": [
            {
              "names": [
                "--"
              ],
              "description": "End of command options"
            }
          ],
          "args": [
            {
              "name": "path",
              "description": "Path to specified submodule"
            },
            {
              "name": "newurl",
              "description": "New url of submodule"
            }
          ]
        },
        {
          "name": "summary",
          "description": "Show commit summary between the given commit (defaults to HEAD) and working tree/index",
          "options": [
            {
              "names": [
                "--cached"
              ],
              "description": "This command will recurse into the registered submodules, and sync any nested submodules within"
            },
            {
              "names": [
                "--files"
              ],
              "description": "Show the series of commits in the submodule between the index of the super project and the working tree of the submodule"
            },
            {
              "names": [
                "-n"
              ],
              "description": "Limit the summary size (number of commits shown in total). Giving 0 will disable the summary; a negative number means unlimited (the default). This limit only applies to modified submodules. The size is always limited to 1 for added/deleted/typechanged submodules",
              "args": {
                "name": "n"
              }
            },
            {
              "names": [
                "--summary-limit"
              ],
              "description": "Limit the summary size (number of commits shown in total). Giving 0 will disable the summary; a negative number means unlimited (the default). This limit only applies to modified submodules. The size is always limited to 1 for added/deleted/typechanged submodules",
              "args": {
                "name": "n"
              }
            },
            {
              "names": [
                "--"
              ],
              "description": "Everything after this is an argument"
            }
          ],
          "args": [
            {
              "name": "commit",
              "isOptional": true
            },
            {
              "name": "path",
              "isVariadic": true,
              "isOptional": true
            }
          ]
        },
        {
          "name": "foreach",
          "description": "Evaluates an arbitrary shell command in each checked out submodule",
          "options": [
            {
              "names": [
                "--recursive"
              ],
              "description": "This command will recurse into the registered submodules, and sync any nested submodules within"
            }
          ],
          "args": [
            {
              "name": "command"
            }
          ]
        },
        {
          "name": "sync",
          "description": "Synchronizes submodules' remote URL configuration setting to the value specified in .gitmodules",
          "options": [
            {
              "names": [
                "--recursive"
              ],
              "description": "This command will recurse into the registered submodules, and sync any nested submodules within"
            },
            {
              "names": [
                "--"
              ],
              "description": "Everything after this is an argument"
            }
          ],
          "args": [
            {
              "name": "path",
              "isVariadic": true,
              "isOptional": true
            }
          ]
        },
        {
          "name": "absorbgitdirs",
          "description": "If a git directory of a submodule is inside the submodule, move the git directory of the submodule into its superproject’s $GIT_DIR/modules path and then connect the git directory and its working directory by setting the core.worktree and adding a .git file pointing to the git directory embedded in the superprojects git directory"
        }
      ],
      "options": [
        {
          "names": [
            "-q",
            "--quiet"
          ],
          "description": "Only print error messages"
        },
        {
          "names": [
            "--cached"
          ],
          "description": "The commit stored in the index is used instead"
        }
      ]
    },
    {
      "name": "merge",
      "description": "Join two or more development histories together",
      "options": [
        {
          "names": [
            "--commit"
          ],
          "description": "Perform the merge and commit the result. This option can be used to override --no-commit"
        },
        {
          "names": [
            "--no-commit"
          ],
          "description": "Perform the merge and stop just before creating a merge commit, to give the user a chance to inspect and further tweak the merge result before committing"
        },
        {
          "names": [
            "--edit",
            "-e"
          ],
          "description": "Invoke an editor before committing successful mechanical merge to further edit the auto-generated merge message, so that the user can explain and justify the merge"
        },
        {
          "names": [
            "--no-edit"
          ],
          "description": "The --no-edit option can be used to accept the auto-generated message (this is generally discouraged). The --edit (or -e) option is still useful if you are giving a draft message with the -m option from the command line and want to edit it in the editor"
        },
        {
          "names": [
            "--cleanup"
          ],
          "description": "This option determines how the merge message will be cleaned up before committing. See git-commit[1] for more details. In addition, if the <mode> is given a value of scissors, scissors will be appended to MERGE_MSG before being passed on to the commit machinery in the case of a merge conflict",
          "args": {
            "name": "mode",
            "suggestions": [
              "strip",
              "whitespace",
              "verbatim",
              "scissors",
              "default"
            ]
          }
        },
        {
          "names": [
            "--ff"
          ],
          "description": "When possible resolve the merge as a fast-forward (only update the branch pointer to match the merged branch; do not create a merge commit). When not possible (when the merged-in history is not a descendant of the current history), create a merge commit"
        },
        {
          "names": [
            "--no-ff"
          ],
          "description": "Create a merge commit in all cases, even when the merge could instead be resolved as a fast-forward"
        },
        {
          "names": [
            "--ff-only"
          ],
          "description": "Resolve the merge as a fast-forward when possible. When not possible, refuse to merge and exit with a non-zero status"
        },
        {
          "names": [
            "-S",
            "--gpg-sign"
          ],
          "description": "GPG-sign the resulting merge commit. The keyid argument is optional and defaults to the committer identity; if specified, it must be stuck to the option without a space",
          "args": {
            "name": "keyid",
            "isOptional": true
          }
        },
        {
          "names": [
            "--no-gpg-sign"
          ],
          "description": "Is useful to countermand both commit.gpgSign configuration variable, and earlier --gpg-sign"
        },
        {
          "names": [
            "--log"
          ],
          "description": "In addition to branch names, populate the log message with one-line descriptions from at most <n> actual commits that are being merged. See also git-fmt-merge-msg[1]",
          "args": {
            "name": "n",
            "isOptional": true
          }
        },
        {
          "names": [
            "--no-log"
          ],
          "description": "Do not list one-line descriptions from the actual commits being merged"
        },
        {
          "names": [
            "--signoff"
          ],
          "description": "Add a Signed-off-by trailer by the committer at the end of the commit log message. The meaning of a signoff depends on the project to which you’re committing. For example, it may certify that the committer has the rights to submit the work under the project’s license or agrees to some contributor representation, such as a Developer Certificate of Origin. (See http://developercertificate.org for the one used by the Linux kernel and Git projects.) Consult the documentation or leadership of the project to which you’re contributing to understand how the signoffs are used in that project"
        },
        {
          "names": [
            "--no-signoff"
          ],
          "description": "Can be used to countermand an earlier --signoff option on the command line"
        },
        {
          "names": [
            "--stat"
          ],
          "description": "Show a diffstat at the end of the merge. The diffstat is also controlled by the configuration option merge.stat"
        },
        {
          "names": [
            "-n",
            "--no-stat"
          ],
          "description": "Do not show a diffstat at the end of the merge"
        },
        {
          "names": [
            "--squash"
          ],
          "description": "With --squash, --commit is not allowed, and will fail. Produce the working tree and index state as if a real merge happened (except for the merge information), but do not actually make a commit, move the HEAD, or record $GIT_DIR/MERGE_HEAD (to cause the next git commit command to create a merge commit). This allows you to create a single commit on top of the current branch whose effect is the same as merging another branch (or more in case of an octopus)"
        },
        {
          "names": [
            "--no-squash"
          ],
          "description": "Perform the merge and commit the result. This option can be used to override --squash"
        },
        {
          "names": [
            "--no-verify"
          ],
          "description": "This option bypasses the pre-merge and commit-msg hooks. See also githooks[5]"
        },
        {
          "names": [
            "-s",
            "--strategy"
          ],
          "description": "Use the given merge strategy; can be supplied more than once to specify them in the order they should be tried. If there is no -s option, a built-in list of strategies is used instead (git merge-recursive when merging a single head, git merge-octopus otherwise)",
          "args": {
            "name": "strategy",
            "isVariadic": true,
            "suggestions": [
              "resolve",
              "recursive",
              "octopus",
              "ours",
              "subtree"
            ]
          }
        },
        {
          "names": [
            "-X",
            "--strategy-option"
          ],
          "description": "Pass merge strategy specific option through to the merge strategy",
          "args": {
            "name": "option",
            "suggestions": [
              "ours",
              "theirs",
              "patience",
              "diff-algorithm",
              "diff-algorithm=patience",
              "diff-algorithm=minimal",
              "diff-algorithm=histogram",
              "diff-algorithm=myers",
              "ignore-space-change",
              "ignore-all-space",
              "ignore-space-at-eol",
              "ignore-cr-at-eol",
              "renormalize",
              "no-renormalize",
              "no-renames",
              "find-renames",
              "subtree"
            ]
          }
        },
        {
          "names": [
            "--verify-signatures"
          ],
          "description": "Verify that the tip commit of the side branch being merged is signed with a valid key, i.e. a key that has a valid uid: in the default trust model, this means the signing key has been signed by a trusted key. If the tip commit of the side branch is not signed with a valid key, the merge is aborted"
        },
        {
          "names": [
            "--no-verify-signatures"
          ],
          "description": "Do not verify that the tip commit of the side branch being merged is signed with a valid key"
        },
        {
          "names": [
            "--summary"
          ],
          "description": "Synonym to --stat ; this is deprecated and will be removed in the future"
        },
        {
          "names": [
            "--no-summary"
          ],
          "description": "Synonym to --no-stat ; this is deprecated and will be removed in the future"
        },
        {
          "names": [
            "-q",
            "--quiet"
          ],
          "description": "Operate quietly. Implies --no-progress"
        },
        {
          "names": [
            "-v",
            "--verbose"
          ],
          "description": "Be verbose"
        },
        {
          "names": [
            "--progress"
          ],
          "description": "Turn progress on/off explicitly. If neither is specified, progress is shown if standard error is connected to a terminal. Note that not all merge strategies may support progress reporting"
        },
        {
          "names": [
            "--no-progress"
          ],
          "description": "Turn progress on/off explicitly. If neither is specified, progress is shown if standard error is connected to a terminal. Note that not all merge strategies may support progress reporting"
        },
        {
          "names": [
            "--autostash"
          ],
          "description": "Automatically create a temporary stash entry before the operation begins, and apply it after the operation ends. This means that you can run the operation on a dirty worktree. However, use with care: the final stash application after a successful merge might result in non-trivial conflicts"
        },
        {
          "names": [
            "--no-autostash"
          ],
          "description": "Do not automatically create a temporary stash entry before the operation begins, and apply it after the operation ends"
        },
        {
          "names": [
            "--allow-unrelated-histories"
          ],
          "description": "By default, git merge command refuses to merge histories that do not share a common ancestor. This option can be used to override this safety when merging histories of two projects that started their lives independently. As that is a very rare occasion, no configuration variable to enable this by default exists and will not be added"
        },
        {
          "names": [
            "-m"
          ],
          "description": "Set the commit message to be used for the merge commit (in case one is created). If --log is specified, a shortlog of the commits being merged will be appended to the specified message. The git fmt-merge-msg command can be used to give a good default for automated git merge invocations. The automated message can include the branch description",
          "args": {
            "name": "message"
          }
        },
        {
          "names": [
            "-F",
            "--file"
          ],
          "description": "Read the commit message to be used for the merge commit (in case one is created). If --log is specified, a shortlog of the commits being merged will be appended to the specified message",
          "args": {
            "name": "file"
          }
        },
        {
          "names": [
            "--rerere-autoupdate"
          ],
          "description": "Allow the rerere mechanism to update the index with the result of auto-conflict resolution if possible"
        },
        {
          "names": [
            "--no-rerere-autoupdate"
          ],
          "description": "Do not allow the rerere mechanism to update the index with the result of auto-conflict resolution if possible"
        },
        {
          "names": [
            "--overwrite-ignore"
          ],
          "description": "Silently overwrite ignored files from the merge result. This is the default behavior. Use --no-overwrite-ignore to abort"
        },
        {
          "names": [
            "--no-overwrite-ignore"
          ],
          "description": "Do not silently overwrite ignored files from the merge result"
        },
        {
          "names": [
            "--abort"
          ],
          "description": "Abort the current conflict resolution process, and try to reconstruct the pre-merge state. If an autostash entry is present, apply it to the worktree. If there were uncommitted worktree changes present when the merge started, git merge --abort will in some cases be unable to reconstruct these changes. It is therefore recommended to always commit or stash your changes before running git merge. git merge --abort is equivalent to git reset --merge when MERGE_HEAD is present unless MERGE_AUTOSTASH is also present in which case git merge --abort applies the stash entry to the worktree whereas git reset --merge will save the stashed changes in the stash list"
        },
        {
          "names": [
            "--quit"
          ],
          "description": "Forget about the current merge in progress. Leave the index and the working tree as-is. If MERGE_AUTOSTASH is present, the stash entry will be saved to the stash list"
        },
        {
          "names": [
            "--continue"
          ],
          "description": "After a git merge stops due to conflicts you can conclude the merge by running git merge --continue (see 'HOW TO RESOLVE CONFLICTS' section below)"
        }
      ],
      "args": [
        {
          "name": "branch",
          "isVariadic": true,
          "isOptional": true,
          "suggestions": [
            "-"
          ],
          "generators": [
            {
              "kind": "script",
              "script": [
                "git",
                "--no-optional-locks",
                "branch",
                "-a",
                "--no-color",
                "--sort=-committerdate"
              ]
            }
          ]
        }
      ]
    },
    {
      "name": "mergetool",
      "description": "Open the git tool to fix conflicts"
    },
    {
      "name": "tag",
      "description": "Create, list, delete or verify a tag object signed with GPG",
      "options": [
        {
          "names": [
            "-l",
            "--list"
          ],
          "description": "List tag names"
        },
        {
          "names": [
            "-n"
          ],
          "description": "Print <n> lines of each tag message",
          "args": {
            "name": "n",
            "suggestions": [
              "1",
              "2",
              "3"
            ]
          }
        },
        {
          "names": [
            "-d",
            "--delete"
          ],
          "description": "Delete tags"
        },
        {
          "names": [
            "-v",
            "--verify"
          ],
          "description": "Verify tags"
        },
        {
          "names": [
            "-a",
            "--annotate"
          ],
          "description": "Annotated tag, needs a message"
        },
        {
          "names": [
            "-m",
            "--message"
          ],
          "description": "Tag message",
          "args": {
            "name": "message"
          }
        },
        {
          "names": [
            "--points-at"
          ],
          "description": "List tags of the given object",
          "args": {
            "name": "object",
            "suggestions": [
              "HEAD",
              "HEAD~<N>"
            ],
            "generators": [
              {
                "kind": "script",
                "script": [
                  "git",
                  "--no-optional-locks",
                  "log",
                  "--oneline"
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "tagname",
          "description": "Select a tag",
          "isOptional": true,
          "generators": [
            {
              "kind": "script",
              "script": [
                "git",
                "--no-optional-locks",
                "tag",
                "--list",
                "--sort=-committerdate"
              ]
            }
          ]
        }
      ]
    },
    {
      "name": "restore",
      "description": "Restore working tree files",
      "options": [
        {
          "names": [
            "-s",
            "--source"
          ],
          "description": "Restore the working tree files with the content from the given tree",
          "args": {
            "name": "tree"
          }
        },
        {
          "names": [
            "-p",
            "--patch"
          ],
          "description": "Interactively select hunks in the difference between the restore source and the restore location"
        },
        {
          "names": [
            "-W",
            "--worktree"
          ],
          "description": "Use the worktree as the restore location"
        },
        {
          "names": [
            "-S",
            "--staged"
          ],
          "description": "Use staging as the restore location"
        },
        {
          "names": [
            "-q",
            "--quiet"
          ],
          "description": "Quiet, suppress feedback messages"
        },
        {
          "names": [
            "--progress"
          ],
          "description": "Progress status is reported on the standard error stream by default when it is attached to a terminal"
        },
        {
          "names": [
            "--no-progress"
          ],
          "description": "Disable progress status reporting"
        },
        {
          "names": [
            "-2",
            "--ours"
          ],
          "description": "When restoring paths from the index, check out stage #2 (ours) for unmerged paths"
        },
        {
          "names": [
            "-3",
            "--theirs"
          ],
          "description": "When re out paths from the index, check out stage #3 (theirs) for unmerged paths"
        },
        {
          "names": [
            "-m",
            "--merge"
          ],
          "description": "When restoring files on the working tree from the index, recreate the conflicted merge in the unmerged paths"
        },
        {
          "names": [
            "--conflict"
          ],
          "description": "The same as --merge option, but changes the way the conflicting hunks are presented",
          "args": {
            "name": "style",
            "suggestions": [
              "merge",
              "diff3"
            ]
          }
        },
        {
          "names": [
            "--ignore-unmerged"
          ],
          "description": "When restoring files on the working tree from the index, do not abort the operation if there are unmerged entries"
        },
        {
          "names": [
            "--ignore-skip-worktree-bits"
          ],
          "description": "In sparse checkout mode, by default is to only update entries matched by <pathspec> and sparse patterns in $GIT_DIR/info/sparse-checkout"
        },
        {
          "names": [
            "--recurse-submodules"
          ],
          "description": "If <pathspec> names an active submodule and the restore location includes the working tree, the submodule will only be updated if this option is given, in which case its working tree will be restored to the commit recorded in the superproject, and any local modifications overwritten"
        },
        {
          "names": [
            "--no-recurse-submodules"
          ],
          "description": "Submodules working trees will not be updated"
        },
        {
          "names": [
            "--overlay"
          ],
          "description": "In overlay mode, the command never removes files when restoring"
        },
        {
          "names": [
            "--no-overlay"
          ],
          "description": "In no-overlay mode, tracked files that do not appear in the --source tree are removed, to make them match <tree> exactly"
        },
        {
          "names": [
            "--pathspec-from-file"
          ],
          "description": "Pathspec is passed in <file> instead of commandline args. If <file> is exactly - then standard input is used",
          "args": {
            "name": "file"
          }
        },
        {
          "names": [
            "--pathspec-file-nul"
          ],
          "description": "Only meaningful with --pathspec-from-file. Pathspec elements are separated with NUL character and all other characters are taken literally (including newlines and quotes)"
        },
        {
          "names": [
            "--"
          ],
          "description": "Do not interpret any more arguments as options"
        }
      ],
      "args": [
        {
          "name": "pathspec",
          "isVariadic": true,
          "isOptional": true,
          "generators": [
            {
              "kind": "script",
              "script": [
                "git",
                "--no-optional-locks",
                "status",
                "--short"
              ]
            }
          ]
        }
      ]
    },
    {
      "name": "switch",
      "description": "Switch branches",
      "options": [
        {
          "names": [
            "-c",
            "--create"
          ],
          "description": "Create a new branch named <new-branch> starting at <start-point> before switching to the branch",
          "args": {
            "name": "new branch"
          }
        },
        {
          "names": [
            "-C",
            "--force-create"
          ],
          "description": "Similar to --create except that if <new-branch> already exists it will be reset to <start-point>",
          "args": {
            "name": "new branch"
          }
        },
        {
          "names": [
            "-d",
            "--detach"
          ],
          "description": "Switch to a commit for inspection and discardable experiments"
        },
        {
          "names": [
            "--guess"
          ],
          "description": "If <branch> is not found but there does exist a tracking branch in exactly one remote (call it <remote>) with a matching name"
        },
        {
          "names": [
            "--no-guess"
          ],
          "description": "Disable --guess"
        },
        {
          "names": [
            "-f",
            "--force"
          ],
          "description": "An alias for --discard-changes"
        },
        {
          "names": [
            "--discard-changes"
          ],
          "description": "Proceed even if the index or the working tree differs from HEAD. Both the index and working tree are restored to match the switching target"
        },
        {
          "names": [
            "-m",
            "--merge"
          ],
          "description": "If you have local modifications to one or more files that are different between the current branch and the branch to which you are switching, the command refuses to switch branches in order to preserve your modifications in context"
        },
        {
          "names": [
            "--conflict"
          ],
          "description": "The same as --merge option above, but changes the way the conflicting hunks are presented, overriding the merge.conflictStyle configuration variable",
          "args": {
            "name": "style",
            "suggestions": [
              "merge",
              "diff3"
            ]
          }
        },
        {
          "names": [
            "-q",
            "--quiet"
          ],
          "description": "Quiet, suppress feedback messages"
        },
        {
          "names": [
            "--progress"
          ],
          "description": "Progress status is reported on the standard error stream by default when it is attached to a terminal"
        },
        {
          "names": [
            "--no-progress"
          ],
          "description": "Disable progress status reporting"
        },
        {
          "names": [
            "-t",
            "--track"
          ],
          "description": "When creating a new branch, set up 'upstream' configuration",
          "args": {
            "name": "branch",
            "generators": [
              {
                "kind": "script",
                "script": [
                  "git",
                  "--no-optional-locks",
                  "branch",
                  "--no-color",
                  "--sort=-committerdate"
                ]
              }
            ]
          }
        },
        {
          "names": [
            "--no-track"
          ],
          "description": "Do not set up 'upstream' configuration, even if the branch.autoSetupMerge configuration variable is true",
          "args": {
            "generators": [
              {
                "kind": "script",
                "script": [
                  "git",
                  "--no-optional-locks",
                  "branch",
                  "--no-color",
                  "--sort=-committerdate"
                ]
              }
            ]
          }
        },
        {
          "names": [
            "--orphan"
          ],
          "description": "Create a new orphan branch, named <new-branch>",
          "args": {
            "name": "new branch"
          }
        },
        {
          "names": [
            "--ignore-other-worktrees"
          ],
          "description": "Git switch refuses when the wanted ref is already checked out by another worktree"
        },
        {
          "names": [
            "--recurse-submodules"
          ],
          "description": "Updates the content of all active submodules according to the commit recorded in the superproject"
        },
        {
          "names": [
            "--no-recurse-submodules"
          ],
          "description": "Submodules working trees will not be updated"
        }
      ],
      "args": [
        {
          "name": "branch name",
          "description": "Branch or commit to switch to",
          "suggestions": [
            "-"
          ],
          "generators": [
            {
              "kind": "script",
              "script": [
                "git",
                "--no-optional-locks",
                "branch",
                "--no-color",
                "--sort=-committerdate"
              ]
            }
          ]
        },
        {
          "name": "start point",
          "isOptional": true,
          "generators": [
            {
              "kind": "script",
              "script": [
                "git",
                "--no-optional-locks",
                "log",
                "--oneline"
              ]
            }
          ]
        }
      ]
    },
    {
      "name": "worktree",
      "description": "Manage multiple working trees",
      "subcommands": [
        {
          "name": "add",
          "description": "Create <path> and checkout <commit-ish> into it",
          "options": [
            {
              "names": [
                "-f",
                "--force"
              ],
              "description": "By default, add refuses to create a new working tree when <commit-ish> is a branch name and is already checked out by another working tree, or if <path> is already assigned to some working tree but is missing (for instance, if <path> was deleted manually). This option overrides these safeguards. To add a missing but locked working tree path, specify --force twice"
            },
            {
              "names": [
                "-d",
                "--detach"
              ],
              "description": "With add, detach HEAD in the new working tree. See \"DETACHED HEAD\" in git-checkout[1]"
            },
            {
              "names": [
                "--checkout"
              ],
              "description": "By default, add checks out <commit-ish>, however, --no-checkout can be used to suppress checkout in order to make customizations, such as configuring sparse-checkout. See \"Sparse checkout\" in git-read-tree[1]"
            },
            {
              "names": [
                "--lock"
              ],
              "description": "Keep the working tree locked after creation. This is the equivalent of git worktree lock after git worktree add, but without a race condition"
            },
            {
              "names": [
                "-b",
                "-B"
              ],
              "description": "With add, create a new branch named <new-branch> starting at <commit-ish>, and check out <new-branch> into the new working tree. If <commit-ish> is omitted, it defaults to HEAD. By default, -b refuses to create a new branch if it already exists. -B overrides this safeguard, resetting <new-branch> to <commit-ish>",
              "args": {
                "name": "new-branch"
              }
            }
          ]
        },
        {
          "name": "list",
          "description": "List details of each working tree",
          "options": [
            {
              "names": [
                "--porcelain"
              ],
              "description": "With list, output in an easy-to-parse format for scripts. This format will remain stable across Git versions and regardless of user configuration. See below for details"
            },
            {
              "names": [
                "-v",
                "--verbose"
              ],
              "description": "With list, output additional information about worktrees (see below)"
            },
            {
              "names": [
                "--expire"
              ],
              "description": "With list, annotate missing working trees as prunable if they are older than <time>",
              "args": {
                "name": "time"
              }
            }
          ]
        },
        {
          "name": "lock",
          "description": "If a working tree is on a portable device or network share which is not always mounted, lock it to prevent its administrative files from being pruned automatically",
          "options": [
            {
              "names": [
                "--reason"
              ],
              "description": "With lock or with add --lock, an explanation <reason> why the working tree is locked",
              "args": {
                "name": "reason"
              }
            }
          ],
          "args": [
            {
              "name": "worktree",
              "description": "Working trees can be identified by path, either relative or absolute"
            }
          ]
        },
        {
          "name": "move",
          "description": "Move a working tree to a new location",
          "options": [
            {
              "names": [
                "-f",
                "--force"
              ],
              "description": "Move refuses to move a locked working tree unless --force is specified twice. If the destination is already assigned to some other working tree but is missing (for instance, if <new-path> was deleted manually), then --force allows the move to proceed; use --force twice if the destination is locked"
            }
          ],
          "args": [
            {
              "name": "worktree",
              "description": "Working trees can be identified by path, either relative or absolute"
            },
            {
              "name": "new-path"
            }
          ]
        },
        {
          "name": "prune",
          "description": "Prune working tree information in $GIT_DIR/worktrees",
          "options": [
            {
              "names": [
                "-n",
                "--dry-run"
              ],
              "description": "With prune, do not remove anything; just report what it would remove"
            },
            {
              "names": [
                "-v",
                "--verbose"
              ],
              "description": "With prune, report all removals"
            },
            {
              "names": [
                "--expire"
              ],
              "description": "With prune, only expire unused working trees older than <time>",
              "args": {
                "name": "time"
              }
            }
          ]
        },
        {
          "name": "remove",
          "description": "Remove a working tree",
          "options": [
            {
              "names": [
                "-f",
                "--force"
              ],
              "description": "Remove refuses to remove an unclean working tree unless --force is used. To remove a locked working tree, specify --force twice"
            }
          ],
          "args": [
            {
              "name": "worktree",
              "description": "Working trees can be identified by path, either relative or absolute"
            }
          ]
        },
        {
          "name": "repair",
          "description": "Repair working tree administrative files, if possible, if they have become corrupted or outdated due to external factors",
          "args": [
            {
              "name": "path"
            }
          ]
        },
        {
          "name": "unlock",
          "description": "Unlock a working tree, allowing it to be pruned, moved or deleted",
          "args": [
            {
              "name": "worktree",
              "description": "Working trees can be identified by path, either relative or absolute"
            }
          ]
        }
      ]
    },
    {
      "name": "apply",
      "description": "Apply a patch to files and/or to the index",
      "options": [
        {
          "names": [
            "--exclude"
          ],
          "description": "Don't apply changes matching the given path",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--include"
          ],
          "description": "Apply changes matching the given path",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "-p"
          ],
          "description": "Remove <num> leading slashes from traditional diff paths",
          "args": {
            "name": "num"
          }
        },
        {
          "names": [
            "--no-add"
          ],
          "description": "Ignore additions made by the patch"
        },
        {
          "names": [
            "--stat"
          ],
          "description": "Instead of applying the patch, output diffstat for the input"
        },
        {
          "names": [
            "--numstat"
          ],
          "description": "Show number of added and deleted lines in decimal notation"
        },
        {
          "names": [
            "--summary"
          ],
          "description": "Instead of applying the patch, output a summary for the input"
        },
        {
          "names": [
            "--check"
          ],
          "description": "Instead of applying the patch, see if the patch is applicable"
        },
        {
          "names": [
            "--index"
          ],
          "description": "Make sure the patch is applicable to the current index"
        },
        {
          "names": [
            "-N",
            "--intent-to-add"
          ],
          "description": "Mark new files with `git add --intent-to-add`"
        },
        {
          "names": [
            "--cached"
          ],
          "description": "Apply a patch without touching the working tree"
        },
        {
          "names": [
            "--unsafe-paths"
          ],
          "description": "Accept a patch that touches outside the working area"
        },
        {
          "names": [
            "--apply"
          ],
          "description": "Also apply the patch (use with --stat/--summary/--check)"
        },
        {
          "names": [
            "-3",
            "--3way"
          ],
          "description": "Attempt three-way merge if a patch does not apply"
        },
        {
          "names": [
            "--build-fake-ancestor"
          ],
          "description": "Build a temporary index based on embedded index information",
          "args": {
            "name": "file"
          }
        },
        {
          "names": [
            "-z"
          ],
          "description": "Paths are separated with NUL character"
        },
        {
          "names": [
            "-C"
          ],
          "description": "Ensure at least <n> lines of context match",
          "args": {
            "name": "n"
          }
        },
        {
          "names": [
            "--whitespace"
          ],
          "description": "Detect new or modified lines that have whitespace errors",
          "args": {
            "name": "action",
            "suggestions": [
              "nowarn",
              "warn",
              "fix",
              "error",
              "error-all"
            ]
          }
        },
        {
          "names": [
            "--ignore-space-change",
            "--ignore-whitespace"
          ],
          "description": "Ignore changes in whitespace when finding context"
        },
        {
          "names": [
            "-R",
            "--reverse"
          ],
          "description": "Apply the patch in reverse"
        },
        {
          "names": [
            "--unidiff-zero"
          ],
          "description": "Don't expect at least one line of context"
        },
        {
          "names": [
            "--reject"
          ],
          "description": "Leave the rejected hunks in corresponding *.rej files"
        },
        {
          "names": [
            "--allow-overlap"
          ],
          "description": "Allow overlapping hunks"
        },
        {
          "names": [
            "-v",
            "--verbose"
          ],
          "description": "Be verbose"
        },
        {
          "names": [
            "--inaccurate-eof"
          ],
          "description": "Tolerate incorrectly detected missing new-line at the end of file"
        },
        {
          "names": [
            "--recount"
          ],
          "description": "Do not trust the line counts in the hunk headers"
        },
        {
          "names": [
            "--directory"
          ],
          "description": "Prepend <root> to all filenames",
          "args": {
            "name": "root"
          }
        }
      ],
      "args": [
        {
          "name": "patch",
          "isVariadic": true
        }
      ]
    },
    {
      "name": "daemon",
      "description": "A really simple server for Git repositories",
      "options": [
        {
          "names": [
            "--strict-paths"
          ],
          "description": "Match paths exactly (i.e. don’t allow \"/foo/repo\" when the real path is \"/foo/repo.git\" or \"/foo/repo/.git\") and don’t do user-relative paths.  git daemon will refuse to start when this option is enabled and no whitelist is specified"
        },
        {
          "names": [
            "--base-path"
          ],
          "description": "Remap all the path requests as relative to the given path",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--base-path-relaxed"
          ],
          "description": "If --base-path is enabled and repo lookup fails, with this option git daemon will attempt to lookup without prefixing the base path. This is useful for switching to --base-path usage, while still allowing the old paths"
        },
        {
          "names": [
            "--interpolated-path"
          ],
          "description": "To support virtual hosting, an interpolated path template can be used to dynamically construct alternate paths. The template supports %H for the target hostname as supplied by the client but converted to all lowercase, %CH for the canonical hostname, %IP for the server’s IP address, %P for the port number, and %D for the absolute path of the named repository. After interpolation, the path is validated against the directory whitelist",
          "args": {
            "name": "path-template"
          }
        },
        {
          "names": [
            "--export-all"
          ],
          "description": "Allow pulling from all directories that look like Git repositories (have the objects and refs subdirectories), even if they do not have the git-daemon-export-ok file"
        },
        {
          "names": [
            "--inetd"
          ],
          "description": "Have the server run as an inetd service"
        },
        {
          "names": [
            "--listen"
          ],
          "description": "Listen on a specific IP address or hostname. IP addresses can be either an IPv4 address or an IPv6 address if supported. If IPv6 is not supported, then --listen=hostname is also not supported and --listen must be given an IPv4 address. Can be given more than once. Incompatible with --inetd option",
          "args": {
            "name": "host_or_ipaddr"
          }
        },
        {
          "names": [
            "--port"
          ],
          "description": "Listen on an alternative port. Incompatible with --inetd option",
          "args": {
            "name": "port"
          }
        },
        {
          "names": [
            "--init-timeout"
          ],
          "description": "Timeout (in seconds) between the moment the connection is established and the client request is received (typically a rather low value, since that should be basically immediate)",
          "args": {
            "name": "timeout"
          }
        },
        {
          "names": [
            "--max-connections"
          ],
          "description": "Maximum number of concurrent clients, defaults to 32. Set it to zero for no limit",
          "args": {
            "name": "maximum"
          }
        },
        {
          "names": [
            "--syslog"
          ],
          "description": "Short for --log-destination=syslog"
        },
        {
          "names": [
            "--log-destination"
          ],
          "description": "Send log messages to the specified destination. Note that this option does not imply --verbose, thus by default only error conditions will be logged. The default destination is syslog if --inetd or --detach is specified, otherwise stderr",
          "args": {
            "name": "destination",
            "suggestions": [
              "stderr",
              "syslog",
              "none"
            ]
          }
        },
        {
          "names": [
            "--user-path"
          ],
          "description": "Allow ~user notation to be used in requests. When specified with no parameter, requests to git://host/~alice/foo is taken as a request to access foo repository in the home directory of user alice. If --user-path=some-path is specified, the same request is taken as a request to access the some-path/foo repository in the home directory of user alice",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--verbose"
          ],
          "description": "Log details about the incoming connections and requested files"
        },
        {
          "names": [
            "--detach"
          ],
          "description": "Detach from the shell. Implies --syslog"
        },
        {
          "names": [
            "--pid-file"
          ],
          "description": "Save the process id in the provided file",
          "args": {
            "name": "file"
          }
        },
        {
          "names": [
            "--user"
          ],
          "description": "Change daemon’s uid and gid before entering the service loop. When only --user is given without --group, the primary group ID for the user is used. The values of the option are given to getpwnam(3) and getgrnam(3) and numeric IDs are not supported",
          "args": {
            "name": "user"
          }
        },
        {
          "names": [
            "--group"
          ],
          "description": "Change daemon’s gid before entering the service loop. The value of this option is given to getgrnam(3) and numeric IDs are not supported"
        },
        {
          "names": [
            "--enable"
          ],
          "description": "Enable the service site-wide per default",
          "args": {
            "name": "service",
            "suggestions": [
              "upload-pack",
              "upload-archive",
              "receive-pack"
            ]
          }
        },
        {
          "names": [
            "--disable"
          ],
          "description": "Disable the service site-wide per default. Note that a service disabled site-wide can still be enabled per repository if it is marked overridable and the repository enables the service with a configuration item",
          "args": {
            "name": "service",
            "suggestions": [
              "upload-pack",
              "upload-archive",
              "receive-pack"
            ]
          }
        },
        {
          "names": [
            "--allow-override"
          ],
          "description": "Allow overriding the site-wide default with per repository configuration. By default, all the services may be overridden",
          "args": {
            "name": "service",
            "suggestions": [
              "upload-pack",
              "upload-archive",
              "receive-pack"
            ]
          }
        },
        {
          "names": [
            "--forbid-override"
          ],
          "description": "Forbid overriding the site-wide default with per repository configuration. By default, all the services may be overridden",
          "args": {
            "name": "service",
            "suggestions": [
              "upload-pack",
              "upload-archive",
              "receive-pack"
            ]
          }
        },
        {
          "names": [
            "--informative-errors"
          ],
          "description": "When informative errors are turned on, git-daemon will report more verbose errors to the client, differentiating conditions like \"no such repository\" from \"repository not exported\". This is more convenient for clients, but may leak information about the existence of unexported repositories. When informative errors are not enabled, all errors report \"access denied\" to the client"
        },
        {
          "names": [
            "--no-informative-errors"
          ],
          "description": "Turn off informative errors. This option is the default. See --informative-errors for more information"
        },
        {
          "names": [
            "--access-hook"
          ],
          "description": "Every time a client connects, first run an external command specified by the <path> with service name (e.g. \"upload-pack\"), path to the repository, hostname (%H), canonical hostname (%CH), IP address (%IP), and TCP port (%P) as its command-line arguments. The external command can decide to decline the service by exiting with a non-zero status (or to allow it by exiting with a zero status). It can also look at the $REMOTE_ADDR and $REMOTE_PORT environment variables to learn about the requestor when making this decision.\n\nThe external command can optionally write a single line to its standard output to be sent to the requestor as an error message when it declines the service",
          "args": {
            "name": "path"
          }
        }
      ],
      "args": [
        {
          "name": "directory",
          "description": "A directory to add to the whitelist of allowed directories. Unless --strict-paths is specified this will also include subdirectories of each named directory",
          "isVariadic": true
        }
      ]
    }
  ],
  "options": [
    {
      "names": [
        "--version"
      ],
      "description": "Output version"
    },
    {
      "names": [
        "--help"
      ],
      "description": "Output help"
    },
    {
      "names": [
        "-C"
      ],
      "description": "Run as if git was started in <path>",
      "args": {
        "name": "path"
      }
    },
    {
      "names": [
        "-c"
      ],
      "description": "Pass a config parameter to the command",
      "args": {
        "name": "name=value"
      }
    },
    {
      "names": [
        "--exec-path"
      ],
      "description": "Get or set GIT_EXEC_PATH for core Git programs",
      "args": {
        "name": "path",
        "isOptional": true
      }
    },
    {
      "names": [
        "--html-path"
      ],
      "description": "Print Git’s HTML documentation path"
    },
    {
      "names": [
        "--man-path"
      ],
      "description": "Print the manpath for this version of Git"
    },
    {
      "names": [
        "--info-path"
      ],
      "description": "Print the info path documenting this version of Git"
    },
    {
      "names": [
        "-p",
        "--paginate"
      ],
      "description": "Pipe output into `less` or custom $PAGER"
    },
    {
      "names": [
        "--no-pager"
      ],
      "description": "Do not pipe Git output into a pager"
    },
    {
      "names": [
        "--no-replace-objects"
      ],
      "description": "Do not use replacement refs"
    },
    {
      "names": [
        "--no-optional-locks"
      ],
      "description": "Do not perform optional operations that require lock files"
    },
    {
      "names": [
        "--bare"
      ],
      "description": "Treat the repository as a bare repository"
    },
    {
      "names": [
        "--git-dir"
      ],
      "description": "Set the path to the repository dir (`.git`)",
      "args": {
        "name": "path"
      }
    },
    {
      "names": [
        "--work-tree"
      ],
      "description": "Set working tree path",
      "args": {
        "name": "path"
      }
    },
    {
      "names": [
        "--namespace"
      ],
      "description": "Set the Git namespace",
      "args": {
        "name": "name"
      }
    }
  ],
  "args": [
    {
      "name": "alias",
      "description": "Custom user defined git alias",
      "isOptional": true,
      "generators": [
        {
          "kind": "script",
          "script": [
            "git",
            "--no-optional-locks",
            "config",
            "--get-regexp",
            "^alias."
          ]
        }
      ]
    }
  ]
};
