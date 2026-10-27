// The archived experiment is entirely offline. Block accidental future I/O.
import net from 'node:net';
const blocked = () => { throw new Error('Archived local execution reproduction does not permit network access.'); };
globalThis.fetch = blocked;
net.Socket.prototype.connect = blocked;
