// Create the pipeline topics (safe to re-run). 3 partitions each, keyed by MRN.
import { TOPICS, createKafka } from '@pipeline/common';

const admin = createKafka('setup').admin();
await admin.connect();
const existing = new Set(await admin.listTopics());
const missing = Object.values(TOPICS).filter((t) => !existing.has(t));
if (missing.length) {
  await admin.createTopics({ topics: missing.map((topic) => ({ topic, numPartitions: 3, replicationFactor: 1 })) });
}
console.log(missing.length ? `created: ${missing.join(', ')}` : 'all topics already exist');
await admin.disconnect();
