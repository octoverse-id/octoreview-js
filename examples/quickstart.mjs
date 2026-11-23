// Creates a review with a photo and prints its id, the entity's rating summary and the photo URL
// (server docs/spec.md section 18).
//
// Run the server's compose stack and copy its demo settings out first, then build this SDK:
//
//     make up && make dev-env                            # in the octoreview server repository
//     make build && node examples/quickstart.mjs path/to/.octoreview-dev.env
//
// In your application: import { Octoreview } from "@octoverse-id/octoreview";

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Octoreview } from "../dist/index.js";

const envFile = process.argv[2] ?? ".octoreview-dev.env";
let lines;
try {
  lines = readFileSync(envFile, "utf8").split("\n");
} catch {
  console.error(
    `quickstart: cannot read ${envFile} (run \`make dev-env\` in the server repository)`,
  );
  process.exit(1);
}
// KEY=VALUE lines; a variable already set in the environment wins.
const env = {};
for (const line of lines) {
  const [key, ...rest] = line.trim().split("=");
  if (key && rest.length > 0 && !key.startsWith("#")) {
    env[key] = process.env[key] ?? rest.join("=");
  }
}
const client = Octoreview.fromEnv({}, env);

const review = await client.reviews.create({
  // In your application, derive this from your own authenticated user.
  authorId: `quickstart-js-${randomBytes(6).toString("hex")}`,
  rating: 5,
  entityType: "product",
  externalId: "sku-quickstart",
  title: "Fits perfectly",
  body: "Sent with the octoreview JavaScript quickstart.",
});
const media = await client.media.uploadFile(
  review.id,
  fileURLToPath(new URL("photo.png", import.meta.url)),
);
const summary = await client.ratings.get("product", "sku-quickstart");

console.log(`review: ${review.id}`);
console.log(
  `rating: average ${summary.ratingAverage === null ? "none" : summary.ratingAverage.toFixed(2)} from ${summary.ratingCount} published review(s)`,
);
console.log(`photo: ${media.url ?? "(no URL)"}`);
