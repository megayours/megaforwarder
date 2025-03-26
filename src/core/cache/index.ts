import { createCache } from "cache-manager";

const cache = createCache({ ttl: 1000 * 60 * 60 * 24, nonBlocking: false });

export default cache;