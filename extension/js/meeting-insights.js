export const MEETING_INSIGHT_SECTIONS = [
  {
    id: 'summary',
    heading: 'Summary',
    label: 'Summary',
    maxTokens: 700,
    instruction: [
      'Write the Summary section for these meeting notes.',
      'Return only 2 to 4 concise sentences.',
      'Include the main outcome, important context, and attendee consensus if clear.',
    ].join('\n'),
  },
  {
    id: 'topics',
    heading: 'Topics',
    label: 'Topics',
    maxTokens: 500,
    instruction: [
      'Write the Topics section for these meeting notes.',
      'Return only a markdown bullet list.',
      'Use 5 to 10 concise durable topics, not filler words or people-only names.',
    ].join('\n'),
  },
  {
    id: 'moments',
    heading: 'Key Moments',
    label: 'Key Moments',
    maxTokens: 1000,
    instruction: [
      'Write the Key Moments section for these meeting notes.',
      'Return only a markdown bullet list.',
      'Start every bullet with one tag: [decision], [risk], [question], or [highlight].',
      'Prefer decisions, risks, questions, blockers, and important clarifications.',
    ].join('\n'),
  },
  {
    id: 'links',
    heading: 'Shared Links',
    label: 'Shared Links',
    maxTokens: 500,
    instruction: [
      'Write the Shared Links section for these meeting notes.',
      'Return only a markdown bullet list of URLs shared or discussed in the meeting.',
      'Include a short label before each URL when the surrounding transcript gives enough context.',
      'If there are no shared links, return exactly "No shared links."',
    ].join('\n'),
  },
  {
    id: 'actions',
    heading: 'Action Items',
    label: 'Action Items',
    maxTokens: 800,
    instruction: [
      'Write the Action Items section for these meeting notes.',
      'Return only markdown checklist items like "- [ ] Task _(Owner)_ — due date".',
      'If there are no action items, return exactly "No action items."',
    ].join('\n'),
  },
];

export function meetingInsightPrompt(section, transcript) {
  return [
    section.instruction,
    '',
    'Rules:',
    '- Return only the section body; do not include markdown headings.',
    '- Use only evidence from the transcript.',
    '- Be concrete and concise.',
    '',
    'TRANSCRIPT:',
    transcript || '(empty transcript)',
  ].join('\n');
}

export function composeMeetingInsightNotes(parts = {}) {
  return MEETING_INSIGHT_SECTIONS
    .map((section) => {
      const value = typeof parts.get === 'function' ? parts.get(section.id) : parts[section.id];
      return `## ${section.heading}\n${String(value || '').trim()}`;
    })
    .join('\n\n')
    .trim();
}
