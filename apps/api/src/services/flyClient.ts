import axios from "axios";

const FLY_API_BASE = "https://api.machines.dev/v1";

function makeClient() {
  return axios.create({
    baseURL: FLY_API_BASE,
    headers: { Authorization: `Bearer ${process.env.FLY_API_TOKEN}` },
    timeout: 30_000,
  });
}

export async function createFlyApp(appName: string, orgSlug: string): Promise<void> {
  const client = makeClient();
  await client.post("/apps", { app_name: appName, org_slug: orgSlug });
}

export async function destroyFlyApp(appName: string): Promise<void> {
  const client = makeClient();
  try {
    await client.delete(`/apps/${appName}`);
  } catch (err: unknown) {
    if (axios.isAxiosError(err) && err.response?.status === 404) return;
    throw err;
  }
}

export async function allocateFlyIp(appName: string): Promise<string> {
  const client = makeClient();
  const { data } = await client.post(`/apps/${appName}/allocate-shared-ipv4`);
  return data.address as string;
}
