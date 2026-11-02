import { createHash } from "node:crypto";
import { applySearchLinks, applyTemplate } from "./searches.js";
import { checkProject } from "./projects.js";

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
export const projectVersion = project => createHash("sha256").update(JSON.stringify(project)).digest("hex");

export function requestSearchBrief(project, text) {
  if (typeof text !== "string" || !text.trim() || text.length > 8000) fail(400, "Describe your search in 1–8000 characters.");
  return { ...project, searchBrief: { text: text.trim(), revision: (project.searchBrief?.revision ?? 0) + 1, status: "pending", requested_at: new Date().toISOString() } };
}

export function resolveSearchBrief(project, plan) {
  const brief = project.searchBrief;
  if (!brief || brief.status !== "pending" || plan.revision !== brief.revision || plan.projectVersion !== projectVersion(project)) fail(409, "The brief or project changed. Read the project again before applying a plan.");
  if (typeof plan.explanation !== "string" || !plan.explanation.trim() || plan.explanation.length > 4000) fail(400, "Explain how the brief maps to the search and scoring criteria.");
  if (plan.question) {
    if (typeof plan.question !== "string" || plan.question.length > 2000) fail(400, "question must be a short string");
    return { ...project, searchBrief: { ...brief, status: "needs_input", explanation: plan.explanation, question: plan.question } };
  }
  let next;
  // Buying plans carry the searches the agent built on each site; rental plans
  // carry filters for the template.
  try { next = plan.searches ? applySearchLinks(project, "main", plan) : applyTemplate(project, "main", plan); } catch (error) { fail(400, error.message); }
  // Only search/scoring settings belong to a sourcing brief. Never the outgoing
  // introduction, account settings, or the user's other search switches.
  for (const key of ["budget", "home", "criteria", "filters", "skip"]) {
    if (plan.project?.[key] !== undefined) next[key] = plan.project[key];
  }
  const errors = checkProject(next);
  if (errors.length) fail(400, errors.join("; "));
  return { ...next, searchBrief: { ...brief, status: "applied", explanation: plan.explanation, applied_at: new Date().toISOString() } };
}
