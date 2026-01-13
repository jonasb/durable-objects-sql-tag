import { TestDurableObject } from "./test-durable-object.js";

export { TestDurableObject };

interface Env {
  TEST_DURABLE_OBJECT: DurableObjectNamespace<TestDurableObject>;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Route all /test/* requests to the TestDurableObject
    if (url.pathname.startsWith("/test/")) {
      // Extract instance ID from query parameter, or generate a unique one
      const instanceId =
        url.searchParams.get("instanceId") || `test-${Date.now()}-${Math.random()}`;
      const id = env.TEST_DURABLE_OBJECT.idFromName(instanceId);
      const stub = env.TEST_DURABLE_OBJECT.get(id);
      return stub.fetch(request);
    }

    return new Response("Not found", { status: 404 });
  },
};
