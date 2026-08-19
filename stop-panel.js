document.getElementById("stopBtn").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "zinra-stop-bubble-click" }).catch(() => {});
});
