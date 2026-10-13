/**
 * Child process for supervised-restart.spec.ts. It asks for a supervised
 * restart and then holds the event loop open the way a live dsh instance does
 * (servers, sockets), so the module's own SIGTERM — not an empty event loop —
 * is what ends this process. Without that hold the module's unref'd timer
 * would let the process exit on its own and the test would prove nothing.
 */
import { requestRestartIfSupervised } from '../../src/supervised-restart.ts'

const profileDir = process.argv[2]
if (profileDir === undefined) throw new Error('supervised-restart-child needs a profile directory argument')
const keepAlive = setInterval(() => {}, 1000)
const requested = requestRestartIfSupervised(profileDir)
process.stdout.write(`${String(requested)}\n`)
if (!requested) {
  clearInterval(keepAlive)
  process.exit(0)
}
