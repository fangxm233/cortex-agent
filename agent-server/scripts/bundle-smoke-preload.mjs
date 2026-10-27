// All gateway traffic, including usage reads, must stay inside the isolated smoke instance.
// Reuse the real-turn loader so the exported URL and spawned child's port agree.
import './bundle-turn-preload.mjs';
