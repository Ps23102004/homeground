// Server-side re-export of the shared wire contract. See src/types.ts for the
// authoritative definitions and the coordinate-convention doc comment.
export type {
  LocalPoint,
  GeoRequest,
  GeoResponse,
  TileRequest,
  Heightfield,
  BuildingTag,
  Building,
  RoadTag,
  Road,
  TilePayload,
  RunCandidate,
  ShareState,
} from "../src/types.js";
