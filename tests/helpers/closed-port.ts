import net from "node:net";

/**
 * Returns a loopback TCP port that is guaranteed to be closed/unreachable
 * at the moment this resolves: the OS assigns a free ephemeral port to a
 * throwaway server, which is then closed before the port number is
 * returned. Used to produce a deterministic `net::ERR_CONNECTION_REFUSED`
 * for environment-error tests.
 *
 * Deliberately not a fixed low port such as 1 (tcpmux): Chromium refuses
 * to even attempt a connection to a documented list of "unsafe" ports
 * (1, 7, 9, 22, ... — see Chromium's `net::IsPortAllowedForScheme`) and
 * fails with `net::ERR_UNSAFE_PORT` instead of a genuine connection
 * failure, which does not exercise the environment_error path the same
 * way a real unreachable target does.
 */
export function getClosedLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address !== "object") {
        server.close(() => reject(new Error("failed to determine an ephemeral port")));
        return;
      }
      const { port } = address;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}
