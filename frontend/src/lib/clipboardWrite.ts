/**
 * 剪贴板写入（远端 → 本地）。
 *
 * WebView2 里插件 UI 跑在 iframe 中，`navigator.clipboard.writeText` 可能因
 * 权限/焦点被拒且不会弹提示；RDP/VNC 收到远端剪贴板后如果只走这一条路，
 * 表现就是「远端复制了、本地粘贴不出来」。这里补一条 `execCommand("copy")`
 * 兜底：它走的是文档编辑命令，不依赖异步剪贴板权限。
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 权限被拒/焦点不在文档：继续走兜底路径。
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.style.left = "-1000px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    area.setSelectionRange(0, text.length);
    const copied = document.execCommand("copy");
    document.body.removeChild(area);
    return copied;
  } catch {
    return false;
  }
}
