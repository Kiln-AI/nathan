export interface RepoName {
  owner: string;
  name: string;
}

/** Splits "owner/name"; throws on anything else. */
export function parseRepo(repo: string): RepoName {
  const match = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/.exec(repo);
  if (!match?.[1] || !match[2]) throw new Error(`"${repo}" is not an owner/name repository`);
  return { owner: match[1], name: match[2] };
}
