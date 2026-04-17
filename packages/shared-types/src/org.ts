import type { OrgId, ISODateString } from './ids';

export interface Organization {
  id: OrgId;
  slug: string;
  name: string;
  createdAt: ISODateString;
}
