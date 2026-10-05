# Remote architecture

Each connection joins a client to one environment over HTTP and WebSocket. The
environment owns providers, execution, files, and durable state. Direct access,
Tailscale, SSH, and T3 Connect change how the client reaches that server; they do
not introduce another execution model. See
[remote access](../user/remote-access.md) for setup.

## Identity is independent of the route

An environment keeps its ID across server restarts and endpoint changes. Saved
connections are local to a client profile; the server's identity and state are
not. A repository identity can correlate clones across environments, but never
routes work between them. A project and its threads belong to one environment.

[Environment ID initialization](../../apps/server/src/environment/ServerEnvironment.ts)
must publish a complete ID atomically. Repair of an empty ID file retains a
recovery file so concurrent or delayed initializers choose the same winner.
Removing that recovery state as ordinary temporary-file cleanup can change the
identity underneath an already-running server.

Advertised endpoints are reachability hints. Only the connecting device can
prove that a route works. In particular, a host's loopback address refers to a
different machine when another device opens it. Endpoint selection must not
silently fall back to loopback when a shareable endpoint is unavailable.

## Hosted web is a client

The hosted web app stores its connection catalog in the browser and connects
directly to each environment. It does not proxy traffic or hold server-side
pairing state. Hosting the UI over HTTPS therefore cannot make a plain HTTP LAN
backend accessible from that browser context.

A [hosted pairing URL](../../apps/web/src/hostedPairing.ts) identifies the backend
in its query and carries the pairing secret in its fragment. Fragments stay out
of requests to the hosted origin. The browser exchanges the secret with the
environment and strips it from its history. Moving the token into a query
parameter would disclose it to the wrong origin.

## Access and process ownership are different

Tailscale supplies an endpoint for ordinary pairing, so it needs no separate
environment type. Authentication remains the environment's responsibility for
every route. See [environment authentication](./environment-auth.md) and the
[T3 Connect trust boundary](./t3-connect.md).

SSH can launch a server as well as forward a port. Desktop main owns that
lifecycle because it can spawn SSH and handle authentication prompts. The
renderer uses the forwarded endpoint through the shared connection runtime.
[SSH cleanup](../../packages/ssh/src/tunnel.ts) stops a remote server only if the
launcher owns it; a server it discovered already running must survive a client
disconnect. Reconnection restores the forward before opening the application
transport.

Remote servers can outlive several client releases. Clients must use advertised
capabilities and handle their absence, rather than assume their own version
describes the server. Process replacement belongs to the launcher's
[update protocol](./server-updates.md); the connection runtime handles the
resulting disconnect.

### Cubes

A host environment can create cubes: machines (Docker containers or Fly
Machines) that each run their own T3 server, so a paired client sees a complete
environment. The [cube service](../../apps/server/src/cube/CubeService.ts)
only creates, wakes, removes, and pairs cubes; it never runs work inside one.
The backend is the record (Docker labels, Fly app names and machine metadata),
so there is no cube table to drift.

Fly cubes sleep themselves when their agent is idle
([`IdleShutdown`](../../apps/server/src/cube/IdleShutdown.ts)), and Fly wakes
a sleeping machine for any request. So clients must not hold standing
connections to them: each retry would wake the machine again. A server that
sleeps this way advertises `wakesOnRequest`, and clients switch its saved
connection to `connectWhen: "needed"`, connecting on opening a thread, sending,
or other need rather than in the background. The same holds for the cube home
below. Docker cubes cannot wake on request and keep ordinary connections.

Only one server may manage cubes on an account. Each manager keeps exactly one
spare and deletes spares it does not expect, so two managers delete each
other's. Moving management to the cube home therefore turns cubes off on the
old host and clears its Fly token before the home takes over.

The cube home is a small Fly machine running the cube image with no projects.
It sleeps when no client has the app in the foreground and no cube work is
running, so cubes can be made and managed with every computer of the user's
off. Its hourly prune and spare checks run by the wall clock, checked every
minute, because a suspended machine's timers do not count the time it slept.
Pruning destroys a machine without `force`, which Fly refuses for a started
one, so a cube woken after the eligibility check is never deleted.

Docker publishes a cube on a new port each time it starts, so clients
re-resolve their cubes from the host:
[`syncCubeEnvironments`](../../packages/client-runtime/src/state/cube.ts)
registers ones it has not seen and moves saved ones to their current port,
keyed by the cube's environment ID, which survives restarts. A published
container port also crosses Docker's NAT and the host firewall, which host
networking does not; a firewall that filters forwarded traffic makes a LAN or
tailnet publish address unreachable even though the host itself answers there.
Cubes are off by default because access to the Docker daemon is effectively
root on the host.

### Desktop without a local environment

Desktop normally launches its own primary server, but the desktop setting `localEnvironmentEnabled`
(`apps/desktop/src/settings/DesktopAppSettings.ts`) turns that off. Changing it relaunches the app;
no local state is deleted. On the next start the main process skips port selection, server exposure,
and the primary and WSL backends, and opens the window right away. The renderer sees this through
`desktopBridge.getLocalEnvironmentEnabled()`: `readPrimaryEnvironmentTarget` returns null, so primary
auth and platform-managed discovery are skipped and only saved environments (pairing, relay, SSH)
connect. This is possible because the desktop renderer is not served by the backend: the `t3code://`
scheme serves the bundled client from disk (Vite in development) and API traffic always goes to the
environment's own URL.
