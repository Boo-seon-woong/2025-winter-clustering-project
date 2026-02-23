(function () {
  function connect(onMessage) {
    const url = `${location.origin.replace('http', 'ws')}/ws`;
    let ws;
    let retry = 0;

    function open() {
      ws = new WebSocket(url);
      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (onMessage) {
            onMessage(data);
          }
        } catch (_err) {
          // ignore malformed message
        }
      };
      ws.onclose = () => {
        retry = Math.min(retry + 1, 5);
        setTimeout(open, 500 * retry);
      };
    }

    open();
    return () => ws && ws.close();
  }

  window.Ws = { connect };
})();
