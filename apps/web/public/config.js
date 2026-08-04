(() => {
  const isLocal = ["localhost", "127.0.0.1", "0.0.0.0"].includes(window.location.hostname);
  const localWsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";

  window.MATH_BOMBER_WS_URL = isLocal
    ? `${localWsProtocol}//${window.location.host}`
    : "wss://brainbomber-production.up.railway.app";
  window.MATH_BOMBER_API_URL = isLocal
    ? window.location.origin
    : "https://brainbomber-production.up.railway.app";
})();
