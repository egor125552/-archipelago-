import net from "node:net";

const listenPort = Number(process.env.JITTER_PORT || 8788);
const targetPort = Number(process.env.TARGET_PORT || 8787);

function randomDelay(base, spread) {
  return Math.max(0, base + (Math.random() * 2 - 1) * spread);
}

function delayedPipe(source, destination, base, spread) {
  let lastDue = 0;
  source.on("data", chunk => {
    const due = Math.max(Date.now() + randomDelay(base, spread), lastDue + 1);
    lastDue = due;
    setTimeout(() => {
      if (!destination.destroyed) destination.write(chunk);
    }, Math.max(0, due - Date.now()));
  });
  source.on("end", () => {
    setTimeout(() => {
      if (!destination.destroyed) destination.end();
    }, Math.max(0, lastDue - Date.now() + 5));
  });
  source.on("error", () => destination.destroy());
}

net.createServer(client => {
  const upstream = net.connect(targetPort, "127.0.0.1");
  delayedPipe(client, upstream, 90, 35);
  delayedPipe(upstream, client, 130, 80);
  client.on("error", () => upstream.destroy());
  upstream.on("error", () => client.destroy());
}).listen(listenPort, "127.0.0.1", () => {
  console.log(`local action jitter proxy ${listenPort} -> ${targetPort}`);
});
