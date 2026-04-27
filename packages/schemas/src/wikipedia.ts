import { z } from "zod";

export const wikipediaCitationRepairOutputSchema = z.object({
  page_title: z.string().min(1),
  revision_id: z.string().min(1),
  citation_findings: z.array(
    z.object({
      section: z.string().min(1),
      problem: z.enum(["dead_link", "missing_citation", "weak_source", "outdated_source", "claim_mismatch"]),
      current_claim: z.string().min(1),
      evidence_url: z.string().min(1)
    }).strict()
  ).min(1),
  proposed_changes: z.array(
    z.object({
      change_type: z.enum(["replace_citation", "add_citation", "flag_for_editor_review"]),
      target_text: z.string().min(1),
      replacement_text: z.string().min(1),
      source_url: z.string().min(1)
    }).strict()
  ).min(1),
  review_notes: z.string().min(1)
}).strict();

export const wikipediaFreshnessCheckOutputSchema = z.object({
  page_title: z.string().min(1),
  revision_id: z.string().min(1),
  freshness_findings: z.array(
    z.object({
      claim: z.string().min(1),
      status: z.enum(["current", "outdated", "unclear", "needs_editor_review"]),
      evidence_url: z.string().min(1),
      note: z.string().min(1)
    }).strict()
  ).min(1),
  recommended_editor_actions: z.array(z.string().min(1)).min(1),
  risk_level: z.enum(["low", "medium", "high"])
}).strict();

export const wikipediaInfoboxConsistencyOutputSchema = z.object({
  page_title: z.string().min(1),
  revision_id: z.string().min(1),
  checked_fields: z.array(
    z.object({
      field: z.string().min(1),
      current_value: z.string().min(1),
      evidence_url: z.string().min(1),
      status: z.enum(["consistent", "inconsistent", "missing_source", "needs_editor_review"]),
      note: z.string().min(1)
    }).strict()
  ).min(1),
  proposed_changes: z.array(
    z.object({
      field: z.string().min(1),
      target_text: z.string().min(1),
      replacement_text: z.string().min(1),
      source_url: z.string().min(1)
    }).strict()
  ).min(1),
  review_notes: z.string().min(1)
}).strict();

export type WikipediaCitationRepairOutput = z.infer<typeof wikipediaCitationRepairOutputSchema>;
export type WikipediaFreshnessCheckOutput = z.infer<typeof wikipediaFreshnessCheckOutputSchema>;
export type WikipediaInfoboxConsistencyOutput = z.infer<typeof wikipediaInfoboxConsistencyOutputSchema>;

export function validateWikipediaOutput(taskType: string, value: unknown) {
  switch (taskType) {
    case "citation_repair":
      return wikipediaCitationRepairOutputSchema.parse(value);
    case "freshness_check":
      return wikipediaFreshnessCheckOutputSchema.parse(value);
    case "infobox_consistency":
      return wikipediaInfoboxConsistencyOutputSchema.parse(value);
    default:
      throw new Error(`Unsupported Wikipedia task type ${taskType}`);
  }
}
