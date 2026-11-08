// Logs every module the process loads to stderr as "LOAD <url>" — lets a test prove that a short
// command never loads the heavy daemon modules.
import { register } from "node:module";
register("data:text/javascript," + encodeURIComponent(
  `export async function resolve(s, c, next) { const r = await next(s, c); process.stderr.write("LOAD " + r.url + "\\n"); return r; }`,
));
