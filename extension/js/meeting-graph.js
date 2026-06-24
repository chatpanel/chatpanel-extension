// Meeting graph construction shared by the full Meetings graph and the
// per-meeting Topic Graph tab. Keeps UI rendering free of graph filtering rules.

import { isMeetingPersonName } from './meeting-people.js';
import { tokenize } from './meeting-index.js';

export function graphTopicTerms(d) {
  return d?.topicSource === 'transcript' ? [] : [...new Set((d?.terms || []).map((t) => String(t || '').trim()).filter(Boolean))];
}

export function graphParticipantNames(d) {
  return [...new Set((d?.people || []).map((p) => String(p || '').trim()).filter(isMeetingPersonName))];
}

function shouldKeepConnector(ids, itemsLength, focusId) {
  if (itemsLength <= 1) return true;
  if (ids.length >= 2) return true;
  return !!focusId && ids.includes(focusId);
}

function meetingTitle(d) {
  return d?.rec?.title || d?.entry?.title || 'Untitled';
}

function filterByConnectorQuery(nodes, links, query) {
  const terms = tokenize(query || '');
  if (!terms.length) return { nodes, links };
  const matchingConnectors = new Set(nodes
    .filter((node) => node.type !== 'meeting')
    .filter((node) => {
      const labelTerms = new Set(tokenize(node.label || ''));
      return terms.some((term) => labelTerms.has(term));
    })
    .map((node) => node.id));
  if (!matchingConnectors.size) return { nodes, links };

  const keptLinks = links.filter((link) => matchingConnectors.has(link.s) || matchingConnectors.has(link.t));
  const keptIds = new Set(matchingConnectors);
  keptLinks.forEach((link) => {
    keptIds.add(link.s);
    keptIds.add(link.t);
  });
  return {
    nodes: nodes.filter((node) => keptIds.has(node.id)),
    links: keptLinks,
  };
}

export function buildMeetingTopicGraph(items, {
  topicPrefix = 'm-topic:',
  participantPrefix = 'm-participant:',
  focusId = '',
  topicLimit = 6,
  connectorQuery = '',
} = {}) {
  const nodes = [];
  const links = [];
  const topics = new Map();
  const participants = new Map();

  items.forEach((d) => {
    const id = d?.entry?.id;
    if (!id) return;
    nodes.push({ id, type: 'meeting', label: meetingTitle(d), focus: id === focusId });

    graphTopicTerms(d).slice(0, topicLimit).forEach((topic) => {
      const ids = topics.get(topic) || [];
      ids.push(id);
      topics.set(topic, ids);
    });

    graphParticipantNames(d).forEach((participant) => {
      const ids = participants.get(participant) || [];
      ids.push(id);
      participants.set(participant, ids);
    });
  });

  for (const [topic, ids] of topics) {
    const uniqueIds = [...new Set(ids)];
    if (!shouldKeepConnector(uniqueIds, items.length, focusId)) continue;
    const tid = `${topicPrefix}${topic}`;
    nodes.push({ id: tid, type: 'topic', label: topic });
    uniqueIds.forEach((id) => links.push({ s: id, t: tid }));
  }

  for (const [participant, ids] of participants) {
    const uniqueIds = [...new Set(ids)];
    if (!shouldKeepConnector(uniqueIds, items.length, focusId)) continue;
    const pid = `${participantPrefix}${participant}`;
    nodes.push({ id: pid, type: 'participant', label: participant });
    uniqueIds.forEach((id) => links.push({ s: id, t: pid }));
  }

  if (!links.length && items.length > 1) {
    const first = items.find((d) => d?.entry?.id)?.entry?.id;
    items.slice(1).forEach((d) => {
      if (first && d?.entry?.id) links.push({ s: first, t: d.entry.id });
    });
  }

  return filterByConnectorQuery(nodes, links, connectorQuery);
}
