import { SELF } from "cloudflare:test";

interface TestContext {
  instanceId: string;
  urlWithInstance: (path: string) => string;
  insertTestUsers: () => Promise<void>;
  cleanup: () => Promise<void>;
}

export function createTestContext(testSuite: string): TestContext {
  const instanceId = `${testSuite}-${Date.now()}`;
  const baseUrl = `http://example.com/test`;
  const urlWithInstance = (path: string) => `${baseUrl}${path}?instanceId=${instanceId}`;

  const insertTestUsers = async () => {
    await SELF.fetch(urlWithInstance("/run"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "user1",
        name: "Alice",
        email: "alice@example.com",
      }),
    });
    await SELF.fetch(urlWithInstance("/run"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "user2",
        name: "Bob",
        email: "bob@example.com",
      }),
    });
    await SELF.fetch(urlWithInstance("/run"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "user3",
        name: "Charlie",
        email: "charlie@example.com",
      }),
    });
  };

  const cleanup = async () => {
    await SELF.fetch(urlWithInstance("/cleanup"));
  };

  return {
    instanceId,
    urlWithInstance,
    insertTestUsers,
    cleanup,
  };
}
