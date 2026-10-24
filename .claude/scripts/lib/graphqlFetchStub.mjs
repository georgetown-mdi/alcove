// Test preload (`node --import`) that replaces the global `fetch` with a stand-in
// for the GitHub GraphQL endpoint, so a board script runs end to end with no
// network. It answers the two query shapes lib/projectItems.mjs sends: the
// items-connection listing (fetchAllItems) and the aliased node lookup
// (fetchItems). Every item is a draft with Status "Todo" and Epic
// STUB_EPIC. `ALCOVE_STUB_LISTING=short` serves a listing whose one page holds
// fewer items than the count it reports. Driven through lib/stubbedBoardRun.mjs.

import { pvtiNodeId } from "./projectItems.mjs";
import {
  STUB_EPIC,
  STUB_FIRST_ID,
  STUB_ITEM_COUNT,
} from "./stubbedBoardRun.mjs";

const fieldValues = (order) => ({
  nodes: [
    {
      __typename: "ProjectV2ItemFieldSingleSelectValue",
      name: "Todo",
      field: { name: "Status" },
    },
    {
      __typename: "ProjectV2ItemFieldTextValue",
      text: STUB_EPIC,
      field: { name: "Epic" },
    },
    {
      __typename: "ProjectV2ItemFieldNumberValue",
      number: order,
      field: { name: "Order" },
    },
  ],
});

function listing(projectNumber) {
  const short = process.env.ALCOVE_STUB_LISTING === "short";
  const served = short ? STUB_ITEM_COUNT - 1 : STUB_ITEM_COUNT;
  const nodes = Array.from({ length: served }, (_, idx) => ({
    id: pvtiNodeId(projectNumber, STUB_FIRST_ID + idx),
    fieldValues: fieldValues(idx),
    content: { __typename: "DraftIssue", title: `Stub item ${idx}` },
  }));
  return {
    organization: {
      projectV2: {
        items: {
          totalCount: STUB_ITEM_COUNT,
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes,
        },
      },
    },
  };
}

function nodeLookup(query) {
  const data = {};
  for (const match of query.matchAll(/(i\d+): node\(id: "(PVTI_[^"]+)"\)/g)) {
    data[match[1]] = {
      fieldValues: fieldValues(0),
      content: {
        __typename: "DraftIssue",
        title: `Stub item ${match[2]}`,
        body: "Stub body line.\n".repeat(200),
      },
    };
  }
  return data;
}

globalThis.fetch = async (_url, init) => {
  const { query } = JSON.parse(init.body);
  const listingMatch = /projectV2\(number: (\d+)\)/.exec(query);
  const data = listingMatch
    ? listing(Number(listingMatch[1]))
    : nodeLookup(query);
  return new Response(JSON.stringify({ data }), { status: 200 });
};
