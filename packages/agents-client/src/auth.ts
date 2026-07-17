/**
 * Auth strategy for the Azure OpenAI data plane.
 *
 * - `apiKey`  — break-glass only (dev/smoke). The resource should have local auth
 *               disabled in production (`disableLocalAuth=true`).
 * - `bearer`  — keyless Microsoft Entra ID. The VS Code extension supplies a token
 *               provider. CRITICAL for Azure US Government: the token audience MUST
 *               be `https://cognitiveservices.azure.us/.default` (NOT the commercial
 *               `.com`), issued by authority `https://login.microsoftonline.us`.
 *               A commercial-audience token is rejected by the Gov data plane with 401.
 *
 * This package stays dependency-free: it never imports `@azure/identity` itself —
 * the host (extension/CLI) constructs the credential and passes `getToken`.
 */
export type TokenProvider =
  | { kind: 'apiKey'; apiKey: string }
  | { kind: 'bearer'; getToken: () => Promise<string> };

/** Azure US Government data-plane token audience for Azure OpenAI / Cognitive Services. */
export const GOV_COGNITIVE_SERVICES_SCOPE = 'https://cognitiveservices.azure.us/.default';

/** Azure US Government Entra authority host. */
export const GOV_AUTHORITY_HOST = 'https://login.microsoftonline.us';
