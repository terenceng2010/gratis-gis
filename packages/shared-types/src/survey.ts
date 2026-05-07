// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Canonical shape stored in a `web_app` Item's data when
 * `template = 'survey'`. The Survey Response Viewer is the
 * "browse what people submitted" companion to the Form template:
 * one map view that surfaces a paired data_layer's submissions
 * with response-friendly affordances (filter to a date range,
 * filter to a single submitter, click a feature to see the full
 * form-rendered receipt).
 *
 * Why a separate template instead of a viewer with extra props:
 * surveys carry first-class concepts (submission timestamp,
 * submitter, attached form definition, response-as-receipt
 * rendering) that the generic Viewer should not have to know
 * about. Keeping it as its own template means the Viewer stays
 * lean and the Survey runtime can grow form-shaped UI without
 * polluting the Viewer's API.
 *
 * Authorization is read-only by definition (you "view responses",
 * never "edit a submission" in this app). Visibility still flows
 * through the same share + geo-limit pipeline as any other item.
 *
 * See docs/web-app-templates.md and #260 for the broader template
 * registry. Survey is template #3 after Editor (#258) and Viewer
 * (#259).
 */

import type { ViewerTool } from './viewer';

export interface SurveyData {
  version: 1;
  /**
   * Required reference to the `form` item this survey app browses.
   * The runtime resolves the paired data_layer (form.data_layer_id;
   * see #283) and renders its submissions as map features. The
   * form's question list is reused as the popup template so each
   * feature opens as a "form receipt" rather than raw attributes.
   */
  formId?: string;
  /**
   * Optional reference to a `map` item. When set, the survey's
   * canvas inherits that map's basemap and viewport. When unset,
   * the runtime fits the camera to the submission feature class.
   * Mirrors ViewerData.mapId.
   */
  mapId?: string;
  /**
   * Read-side tools exposed in the toolbar. Subset of ViewerTool;
   * survey runtimes typically don't need 'measure' but keep the
   * full enum so future surveys can opt in. The default omits
   * measure since most users browsing responses don't reach for it.
   */
  tools: ViewerTool[];
  /**
   * Default time-window filter. When set, the runtime opens with
   * the layer pre-filtered to submissions whose submitted_at falls
   * inside this many days back from "now". null / undefined =
   * show all responses. Authors set this for "respond log -- last
   * 30 days" style surveys; users can clear it at runtime.
   */
  defaultLookbackDays?: number;
  /**
   * Hide the per-respondent "submitted by" column on the popup +
   * attribute table when true. For surveys gathered anonymously
   * (e.g., public feedback drops) where the captured user id is
   * meaningless to the consumer.
   */
  hideSubmitter?: boolean;
}

/**
 * Default toolbar for a freshly-authored Survey Response viewer.
 * Drops 'measure' from the full Viewer set because measuring a
 * pin you're inspecting almost never makes sense; everything
 * else stays for parity with the Read-Only Viewer.
 */
export const DEFAULT_SURVEY_TOOLS: ViewerTool[] = [
  'select',
  'query',
  'attribute-table',
  'legend',
  'print',
];

/**
 * Freshly-created Survey app. Like the Viewer, formId is required
 * to render anything meaningful; the detail page renders an empty
 * state prompting the author to bind a form before clicking Open.
 */
export const DEFAULT_SURVEY: SurveyData = {
  version: 1,
  tools: DEFAULT_SURVEY_TOOLS,
};
