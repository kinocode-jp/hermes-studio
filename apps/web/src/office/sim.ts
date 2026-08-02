import type { ProfileStatus } from "../domain";

export type OfficeLayoutId = "studio" | "lounge";
export type OfficeSizeId = "s" | "m" | "l";

/** World pixel size of one grid cell. The scene scales to fit its container. */
export const CELL = 36;

export type OfficeObjectType = "meeting" | "plant" | "shelf" | "coffee" | "sofa" | "rug";

export type OfficeObject = {
  id: string;
  type: OfficeObjectType;
  x: number;
  y: number;
  w: number;
  h: number;
  solid: boolean;
};

export type DeskSlot = {
  /** Top-left desk cell. Desks are 2×1 cells and solid. */
  x: number;
  y: number;
  /** Walkable cell in front of the desk where the character works. */
  chair: { x: number; y: number };
};

export type OfficeWorld = {
  layout: OfficeLayoutId;
  cols: number;
  rows: number;
  objects: OfficeObject[];
  desks: DeskSlot[];
  blocked: Set<number>;
  /** Wall-mounted task board on the top wall, in cells. */
  board: { x: number; w: number };
};

const SIZE_DIMS: Record<OfficeSizeId, { cols: number; rows: number }> = {
  s: { cols: 20, rows: 12 },
  m: { cols: 26, rows: 14 },
  l: { cols: 32, rows: 16 }
};

function cellKey(cols: number, x: number, y: number): number {
  return y * cols + x;
}

function overlaps(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }, margin = 0): boolean {
  return a.x < b.x + b.w + margin && a.x + a.w + margin > b.x && a.y < b.y + b.h + margin && a.y + a.h + margin > b.y;
}

function fixturesFor(layout: OfficeLayoutId, cols: number, rows: number): OfficeObject[] {
  const cx = Math.floor(cols / 2);
  if (layout === "studio") {
    return [
      { id: "coffee", type: "coffee", x: 1, y: 1, w: 2, h: 1, solid: true },
      { id: "shelf", type: "shelf", x: cols - 6, y: 1, w: 4, h: 1, solid: true },
      { id: "rug", type: "rug", x: cx - 3, y: rows - 7, w: 6, h: 4, solid: false },
      { id: "meeting", type: "meeting", x: cx - 2, y: rows - 6, w: 4, h: 2, solid: true },
      { id: "plant-a", type: "plant", x: 1, y: rows - 2, w: 1, h: 1, solid: true },
      { id: "plant-b", type: "plant", x: cols - 2, y: rows - 2, w: 1, h: 1, solid: true },
      { id: "plant-c", type: "plant", x: cols - 2, y: rows - 5, w: 1, h: 1, solid: true }
    ];
  }
  return [
    { id: "meeting", type: "meeting", x: cols - 6, y: 1, w: 4, h: 2, solid: true },
    { id: "rug", type: "rug", x: 1, y: rows - 5, w: 7, h: 4, solid: false },
    { id: "sofa", type: "sofa", x: 2, y: rows - 4, w: 3, h: 1, solid: true },
    { id: "coffee", type: "coffee", x: 6, y: rows - 3, w: 2, h: 1, solid: true },
    { id: "shelf", type: "shelf", x: 1, y: 1, w: 4, h: 1, solid: true },
    { id: "plant-a", type: "plant", x: cols - 2, y: rows - 2, w: 1, h: 1, solid: true },
    { id: "plant-b", type: "plant", x: cx, y: 1, w: 1, h: 1, solid: true }
  ];
}

/** Front-door reception desk: first free 2×2 island just inside the wall. */
function receptionDesk(cols: number, objects: readonly OfficeObject[]): DeskSlot {
  for (let x = 2; x + 2 <= cols - 2; x += 1) {
    const island = { x, y: 1, w: 2, h: 2 };
    if (!objects.some((object) => object.solid && overlaps(island, object, 0))) {
      return { x, y: 1, chair: { x, y: 2 } };
    }
  }
  // Fallback one row deeper if the wall fixtures fill the entrance row.
  for (let x = 2; x + 2 <= cols - 2; x += 1) {
    const island = { x, y: 2, w: 2, h: 2 };
    if (!objects.some((object) => object.solid && overlaps(island, object, 0))) {
      return { x, y: 2, chair: { x, y: 3 } };
    }
  }
  return { x: 2, y: 2, chair: { x: 2, y: 3 } };
}

/**
 * Builds a walkable office. Desks are placed procedurally so the floor grows
 * with the roster: when a size preset runs out of space, rows are appended.
 */
export function generateWorld(layout: OfficeLayoutId, size: OfficeSizeId, deskCount: number): OfficeWorld {
  const { cols } = SIZE_DIMS[size];
  let { rows } = SIZE_DIMS[size];
  let objects = fixturesFor(layout, cols, rows);
  const desks: DeskSlot[] = [];

  // Seat 0 is the reception desk near the entrance for the default profile.
  let reception = receptionDesk(cols, objects);
  desks.push(reception);

  // Keep the first procedural chair a full character box away from reception.
  let y = 4;
  while (desks.length < deskCount) {
    if (y + 2 >= rows - 1) {
      rows += 3;
      objects = fixturesFor(layout, cols, rows);
      desks.length = 0;
      reception = receptionDesk(cols, objects);
      desks.push(reception);
      y = 4;
      continue;
    }
    for (let x = 2; x + 2 <= cols - 2 && desks.length < deskCount; x += 3) {
      const island = { x, y, w: 2, h: 2 };
      if (overlaps(island, { x: reception.x, y: reception.y, w: 2, h: 2 }, 0)) continue;
      const collides = objects.some((object) => object.solid && overlaps(island, object, 1));
      if (!collides) desks.push({ x, y, chair: { x, y: y + 1 } });
    }
    y += 3;
  }

  const blocked = new Set<number>();
  for (let x = 0; x < cols; x += 1) {
    blocked.add(cellKey(cols, x, 0));
    blocked.add(cellKey(cols, x, rows - 1));
  }
  for (let row = 0; row < rows; row += 1) {
    blocked.add(cellKey(cols, 0, row));
    blocked.add(cellKey(cols, cols - 1, row));
  }
  for (const object of objects) {
    if (!object.solid) continue;
    for (let ox = object.x; ox < object.x + object.w; ox += 1) {
      for (let oy = object.y; oy < object.y + object.h; oy += 1) blocked.add(cellKey(cols, ox, oy));
    }
  }
  for (const desk of desks) {
    blocked.add(cellKey(cols, desk.x, desk.y));
    blocked.add(cellKey(cols, desk.x + 1, desk.y));
  }

  return { layout, cols, rows, objects, desks, blocked, board: { x: Math.max(2, cols - 8), w: 4 } };
}

export function isWalkable(world: OfficeWorld, x: number, y: number): boolean {
  if (x < 1 || y < 1 || x >= world.cols - 1 || y >= world.rows - 1) return false;
  return !world.blocked.has(cellKey(world.cols, x, y));
}

/** Breadth-first shortest path between cells; returns intermediate+target cells. */
export function findPath(world: OfficeWorld, from: { x: number; y: number }, to: { x: number; y: number }): Array<{ x: number; y: number }> {
  if (from.x === to.x && from.y === to.y) return [];
  if (!isWalkable(world, to.x, to.y)) return [];
  const startKey = cellKey(world.cols, from.x, from.y);
  const goalKey = cellKey(world.cols, to.x, to.y);
  const cameFrom = new Map<number, number>([[startKey, startKey]]);
  const queue: number[] = [startKey];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === goalKey) break;
    const cx = current % world.cols;
    const cy = Math.floor(current / world.cols);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!isWalkable(world, nx, ny)) continue;
      const key = cellKey(world.cols, nx, ny);
      if (cameFrom.has(key)) continue;
      cameFrom.set(key, current);
      queue.push(key);
    }
  }
  if (!cameFrom.has(goalKey)) return [];
  const path: Array<{ x: number; y: number }> = [];
  let cursor = goalKey;
  while (cursor !== startKey) {
    path.push({ x: cursor % world.cols, y: Math.floor(cursor / world.cols) });
    cursor = cameFrom.get(cursor)!;
  }
  return path.reverse();
}

export function randomWalkable(world: OfficeWorld): { x: number; y: number } {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const x = 1 + Math.floor(Math.random() * (world.cols - 2));
    const y = 1 + Math.floor(Math.random() * (world.rows - 2));
    if (isWalkable(world, x, y)) return { x, y };
  }
  return world.desks[0]?.chair ?? { x: 2, y: 2 };
}

export function cellCenter(cell: { x: number; y: number }): { x: number; y: number } {
  return { x: (cell.x + 0.5) * CELL, y: (cell.y + 0.5) * CELL };
}

export type SimCharacter = {
  id: string;
  deskIndex: number;
  /** World-pixel center position. */
  x: number;
  y: number;
  path: Array<{ x: number; y: number }>;
  /** Seconds to stand still before choosing the next wander target. */
  pause: number;
  moving: boolean;
  direction: "front" | "right" | "back" | "left";
};

export function createCharacters(world: OfficeWorld, profileIds: string[], previous?: SimCharacter[]): SimCharacter[] {
  return profileIds.map((id, index) => {
    const desk = world.desks[index % Math.max(1, world.desks.length)];
    const spawn = cellCenter(desk?.chair ?? { x: 2 + index, y: 2 });
    const prior = previous?.find((character) => character.id === id);
    const inBounds = prior !== undefined
      && prior.x < world.cols * CELL && prior.y < world.rows * CELL;
    return {
      id,
      deskIndex: index % Math.max(1, world.desks.length),
      x: inBounds ? prior.x : spawn.x,
      y: inBounds ? prior.y : spawn.y,
      path: [],
      pause: Math.random() * 2,
      moving: false,
      direction: prior?.direction ?? "front",
      ...(inBounds ? { path: [], pause: 0.2 } : {})
    };
  });
}

function currentCell(character: SimCharacter): { x: number; y: number } {
  return { x: Math.floor(character.x / CELL), y: Math.floor(character.y / CELL) };
}

/** Advances every character by dt seconds. Statuses steer desk vs. wander mode. */
export function tickCharacters(
  world: OfficeWorld,
  characters: SimCharacter[],
  statuses: ReadonlyMap<string, ProfileStatus>,
  dt: number
): void {
  for (const character of characters) {
    const status = statuses.get(character.id) ?? "idle";
    const desk = world.desks[character.deskIndex];
    const atDeskDuty = status !== "idle" && desk !== undefined;

    if (character.path.length === 0) {
      character.moving = false;
      if (atDeskDuty) {
        const cell = currentCell(character);
        if (cell.x !== desk.chair.x || cell.y !== desk.chair.y) {
          character.path = findPath(world, cell, desk.chair);
        }
      } else {
        character.pause -= dt;
        if (character.pause <= 0) {
          character.path = findPath(world, currentCell(character), randomWalkable(world));
          character.pause = 1.5 + Math.random() * 4;
        }
      }
    }

    const next = character.path[0];
    if (!next) continue;
    const target = cellCenter(next);
    const dx = target.x - character.x;
    const dy = target.y - character.y;
    const distance = Math.hypot(dx, dy);
    const speed = atDeskDuty ? 110 : 72;
    const step = speed * dt;
    character.moving = true;
    if (Math.abs(dx) >= Math.abs(dy) && Math.abs(dx) > 1) {
      character.direction = dx < 0 ? "left" : "right";
    } else if (Math.abs(dy) > 1) {
      character.direction = dy < 0 ? "back" : "front";
    }
    if (distance <= step) {
      character.x = target.x;
      character.y = target.y;
      character.path.shift();
    } else {
      character.x += (dx / distance) * step;
      character.y += (dy / distance) * step;
    }
  }
}
