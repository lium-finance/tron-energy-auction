// Preloaded with --import in tests that must make no network call: every DNS lookup or resolve, DNS Resolver, TCP connect
// or UDP socket writes a marker to stderr and throws, so a test can assert the marker never appears. Local IPC (a socket
// path, which tsx uses between its processes) is let through.
import dgram from "node:dgram";
import dns from "node:dns";
import { writeSync } from "node:fs";
import net from "node:net";

const MARKER = "NETWORK-CALL-BLOCKED";
const block = (what) => {
  writeSync(2, `${MARKER} ${what}\n`);
  throw new Error(`${MARKER} ${what}`);
};

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guarded(...args) {
  // net.connect passes its normalised arguments as one array: [options, callback].
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const isPipe = typeof first === "string" || (typeof first === "object" && first !== null && typeof first.path === "string");
  if (!isPipe) block("tcp connect");
  return connect.apply(this, args);
};

class BlockedResolver {
  constructor() {
    block("dns Resolver");
  }
}
for (const [target, name] of [[dns, "dns"], [dns.promises, "dns.promises"]]) {
  for (const key of Object.keys(target)) {
    if (key === "lookup" || key === "lookupService" || key.startsWith("resolve") || key === "reverse") {
      target[key] = name === "dns" ? (..._args) => block(`${name}.${key}`) : async (..._args) => block(`${name}.${key}`);
    }
  }
  target.Resolver = BlockedResolver;
}
dgram.createSocket = () => block("dgram createSocket");
