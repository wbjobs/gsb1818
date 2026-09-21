self.onmessage = (event) => {
  const frame = Number(event.data) || 0;
  let result = 0;
  for (let i = 0; i < 8_000_000; i++) {
    result += Math.sqrt(i + frame);
  }
  self.postMessage(result);
};
