// The dev Node of the Gold end to end, and the Character it mines for. Public test words: the same
// Character owns map-1 in compose.yaml (e2e-world/world.spec.ts).
export const NODE_PORT = 8793;
export const NODE_URL = `http://127.0.0.1:${NODE_PORT}`;

export const MINER = {
  address: "tlr1qqqanzv64uheqjxt9vau0el7p0gndh7rmaykuhd3g9h3dyu0fzrr0mqulz55w",
  words:
    "absurd amount doctor acoustic avoid letter advice cage absurd amount doctor acoustic avoid letter advice cage absurd amount doctor acoustic avoid letter advice comic",
} as const;
