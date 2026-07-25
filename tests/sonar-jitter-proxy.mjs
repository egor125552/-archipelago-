import net from "node:net";

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
  source.on("end", () => setTimeout(() => {
    if (!destination.destroyed) destination.end();
  }, Math.max(0, lastDue - Date.now() + 5)));
  source.on("error", () => destination.destroy());
}

net.createServer(client => {
  const upstream = net.connect(8787, "127.0.0.1");
  delayedPipe(client, upstream, 85, 35);
  delayedPipe(upstream, client, 125, 85);
  client.on("error", () => upstream.destroy());
  upstream.on("error", () => client.destroy());
}).listen(8788, "127.0.0.1");
