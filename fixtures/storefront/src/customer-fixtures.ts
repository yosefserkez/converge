// Protected synthetic identity resolution.
//
// The demo selects a customer with the X-Demo-Customer request header. This is
// NOT a production authentication pattern: any caller can claim any fixture
// identity. It exists only so the verification harness can exercise both tiers.
export type MembershipTier = 'member' | 'regular';

export interface CustomerContext {
  customerId: string;
  membershipTier: MembershipTier;
}

const CUSTOMERS: Readonly<Record<string, CustomerContext>> = Object.freeze({
  'member-1': { customerId: 'member-1', membershipTier: 'member' },
  'regular-1': { customerId: 'regular-1', membershipTier: 'regular' },
});

export const CUSTOMER_IDS = Object.keys(CUSTOMERS);

export function resolveCustomer(customerId: string | undefined): CustomerContext | undefined {
  if (customerId === undefined || !Object.hasOwn(CUSTOMERS, customerId)) return undefined;
  const customer = CUSTOMERS[customerId];
  return customer ? { ...customer } : undefined;
}
