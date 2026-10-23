// A small key chip with the token's name beside a person, when what they did was done with a personal
// access token. The key reads as "token" without the acronym, which kept the old "PAT · name" text
// from fitting on one line next to a name and a sentence.

export function ViaBadge({ label }: { label: string | null | undefined }) {
  if (!label) return null;
  return (
    <span className="via-chip" title={`Done with the personal access token “${label}”`}>
      <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden>
        <circle cx="5.5" cy="10.5" r="2.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path d="M7.4 8.6L13 3M11 5l1.6 1.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
      <span className="via-chip-name">{label}</span>
    </span>
  );
}
