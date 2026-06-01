export function validTierCacheAccounts(cacheOrAccounts) {
  const accounts = Array.isArray(cacheOrAccounts)
    ? cacheOrAccounts
    : Array.isArray(cacheOrAccounts?.accounts)
      ? cacheOrAccounts.accounts
      : [];

  return accounts.filter((account) =>
    account &&
    typeof account === 'object' &&
    typeof account.email === 'string' &&
    account.email.length > 0
  );
}

export function tierCacheAccountMap(cacheOrAccounts) {
  return new Map(validTierCacheAccounts(cacheOrAccounts).map((account) => [account.email, account]));
}
