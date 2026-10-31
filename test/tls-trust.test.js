import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { test } from "node:test";
import tls from "node:tls";

// eMudhra intermediate CA keys were compromised in Oct 2026. Node does not
// check revocation, so only a runtime whose bundled roots drop these chains is
// safe for the app's outbound TLS (WhatsApp, photo fetches).
const COMPROMISED_CHAINS = ["emSign Root TLS CA - G3", "emSign Root CS CA - G3", "emSign ECC Root CA - G3", "AAA Certificate Services"];

test("this Node runtime does not trust the roots behind the compromised eMudhra intermediates", () => {
  const trusted = tls.rootCertificates.map((pem) => new X509Certificate(pem).subject.match(/^CN=(.*)$/m)?.[1]);
  const still = COMPROMISED_CHAINS.filter((cn) => trusted.includes(cn));
  assert.deepEqual(still, [], `Node ${process.version} still trusts ${still.join(", ")}; upgrade to 22.23.4, 24.22.1 or 26.12.1 or later`);
});
