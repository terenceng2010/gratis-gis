import type { OrgId, ISODateString } from './ids.js';

export interface Organization {
  id: OrgId;
  slug: string;
  name: string;
  createdAt: ISODateString;
}
