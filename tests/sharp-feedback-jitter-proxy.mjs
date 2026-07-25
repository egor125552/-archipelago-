import net from "node:net";

const listenPort = 8788;
const targetPort = 8787;
let seed = 0x51a9f00d;
const random = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 0x100000000;
};
const delay = direction => {
  const base = direction === "up" ? 95 : 105;
  return base + Math.floor(random() * 75);
};

const server = net.createServer(client => {
  const upstream = net.connect({host: "127.0.0.1", port: targetPort});
  const forward = (source, destination, direction) => {
    source.on("data", chunk => {
      const copy = Buffer.from(chunk);
      setTimeout(() => {
        if (!destination.destroyed) destination.write(copy);
      }, delay(direction));
    });
    source.on("end", () => destination.end());
    source.on("error", () => destination.destroy());
  };
  forward(client, upstream, "up");
  forward(upstream, client, "down");
  upstream.on("error", () => client.destroy());
});

server.listen(listenPort, "127.0.0.1", () => {
  console.log(`sharp feedback proxy ${listenPort} -> ${targetPort}`);
});
