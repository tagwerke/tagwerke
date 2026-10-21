// "PAT · <token name>" beside a person, when what they did was done with a personal access token.

export function ViaBadge({ label }: { label: string | null | undefined }) {
  if (!label) return null;
  return <span className="bot-badge" title="Done with a personal access token">PAT · {label}</span>;
}
