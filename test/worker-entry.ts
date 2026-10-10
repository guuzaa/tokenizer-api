/** Tiny entry for the Vitest worker. The real API runs as an auxiliary worker. */
export default {
  fetch(): Response {
    return new Response("ok");
  },
};
