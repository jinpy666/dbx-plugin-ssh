#!/usr/bin/env python3
"""Exercise the dynamic tunnel menu against a real sidecar, without SSH access."""
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from sidecar_client import SidecarClient


def main() -> None:
    binary = os.environ.get("DBX_PLUGIN_SIDECAR") or str(Path(__file__).parent.parent / "backend/target/debug/dbx-plugin-ssh")
    with tempfile.TemporaryDirectory(prefix="dbx-tunnel-menu-") as data_dir:
        profiles = [{"id": "saved-1", "connectionId": "conn-a", "kind": "dynamic", "listenHost": "127.0.0.1", "listenPort": "1080", "targetHost": "", "targetPort": ""}]
        Path(data_dir, "ui-storage.json").write_text(json.dumps({"ssh-tunnel-profiles": json.dumps(profiles)}))
        client = SidecarClient.start(binary=binary, data_dir=data_dir)
        try:
            client.initialize()
            context = {"connection": {"id": "conn-a", "dbType": "plugin", "name": "Test", "database": ""}, "locale": "zh-CN", "ownerPluginId": "io.dbx.ssh"}
            menu = client.request("contextMenu/resolve/manage-tunnels", context)
            children = menu["items"][0]["children"]
            assert menu["items"][0]["label"] == "端口映射", menu
            assert [item["label"] for item in children] == ["管理端口映射", "启用已保存端口映射", "启动 SOCKS5 127.0.0.1:1080"], menu
            assert children[1]["action"]["reopenConnectionOnMissing"] is True
            other = client.request("contextMenu/resolve/manage-tunnels", {"connection": {"id": "conn-b"}, "ownerPluginId": "io.dbx.ssh"})
            assert len(other["items"][0]["children"]) == 1, other
            unrelated = client.request("contextMenu/resolve/manage-tunnels", {**context, "ownerPluginId": "io.dbx.nacos"})
            assert unrelated == {"items": []}, unrelated
            print("PASS dynamic tunnel menu: saved-profile visibility, locale, connection isolation")
        finally:
            client.close()


if __name__ == "__main__":
    main()
