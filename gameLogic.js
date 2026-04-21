// ============ TILE BAG ============
const TILE_DISTRIBUTION = {
  0: [5, 1],
  1: [6, 1],
  2: [6, 1],
  3: [5, 1],
  4: [5, 2],
  5: [4, 2],
  6: [4, 2],
  7: [4, 2],
  8: [4, 2],
  9: [4, 2],
  10: [2, 3],
  11: [1, 4],
  12: [2, 3],
  13: [1, 6],
  14: [1, 4],
  15: [1, 4],
  16: [1, 4],
  17: [1, 6],
  18: [1, 4],
  19: [1, 7],
  20: [1, 5],
  "+": [4, 2],
  "-": [4, 2],
  "×": [4, 2],
  "÷": [4, 2],
  "=": [11, 1],
  BLANK: [4, 0],
};

let tileCounter = 0;

export function createTileBag() {
  const bag = [];
  for (const [value, [count, points]] of Object.entries(TILE_DISTRIBUTION)) {
    for (let i = 0; i < count; i++) {
      const tileId = `t${tileCounter++}`;
      bag.push({
        id: tileId,
        originalId: tileId, // ✅ เก็บ original ID แยกต่างหาก
        value,
        displayValue: value === "BLANK" ? "" : value,
        points,
        isBlank: value === "BLANK",
      });
    }
  }
  return shuffle(bag);
}

export function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function drawTiles(bag, count) {
  return [bag.slice(0, count), bag.slice(count)];
}

// ============ BOARD ============
const BOARD_LAYOUT = [
  ["R", ".", ".", "O", ".", ".", ".", ".", ".", ".", ".", "O", ".", ".", "R"],
  [".", "Y", ".", ".", ".", ".", ".", ".", ".", ".", ".", ".", ".", "Y", "."],
  [".", ".", "Y", ".", ".", ".", ".", "B", ".", ".", ".", ".", "Y", ".", "."],
  ["O", ".", ".", "Y", ".", ".", ".", ".", ".", ".", ".", "Y", ".", ".", "O"],
  [".", ".", ".", ".", "Y", ".", ".", ".", ".", ".", "Y", ".", ".", ".", "."],
  [".", ".", ".", ".", ".", "B", ".", ".", ".", "B", ".", ".", ".", ".", "."],
  [".", ".", ".", ".", ".", ".", "O", ".", "O", ".", ".", ".", ".", ".", "."],
  [".", ".", "B", ".", ".", ".", ".", "S", ".", ".", ".", "B", ".", ".", "."],
  [".", ".", ".", ".", ".", ".", "O", ".", "O", ".", ".", ".", ".", ".", "."],
  [".", ".", ".", ".", ".", "B", ".", ".", ".", "B", ".", ".", ".", ".", "."],
  [".", ".", ".", ".", "Y", ".", ".", ".", ".", ".", "Y", ".", ".", ".", "."],
  ["O", ".", ".", "Y", ".", ".", ".", ".", ".", ".", ".", "Y", ".", ".", "O"],
  [".", ".", "Y", ".", ".", ".", ".", "B", ".", ".", ".", ".", "Y", ".", "."],
  [".", "Y", ".", ".", ".", ".", ".", ".", ".", ".", ".", ".", ".", "Y", "."],
  ["R", ".", ".", "O", ".", ".", ".", ".", ".", ".", ".", "O", ".", ".", "R"],
];

const TYPE_MAP = {
  R: "TRIPLE_EQ",
  Y: "DOUBLE_EQ",
  B: "TRIPLE_NUM",
  O: "DOUBLE_NUM",
  S: "STAR",
  ".": "NORMAL",
};

export function buildBoard() {
  return BOARD_LAYOUT.map((row, r) =>
    row.map((code, c) => ({
      row: r,
      col: c,
      type: TYPE_MAP[code],
      tile: null,
    })),
  );
}

// ============ VALIDATION ============
function getVal(tile) {
  if (tile.isBlank) return tile.blankValue || "";
  return tile.value;
}

// รวม tile หลักเดียวติดกันเป็นตัวเลขหลายหลัก, tile หลายหลัก push ตรงๆ
function tilesToTokens(tiles) {
  const tokens = [];
  let numBuffer = "";

  for (const tile of tiles) {
    const val = getVal(tile);

    if (/^\d+$/.test(val)) {
      if (val.length > 1) {
        // tile หลายหลัก เช่น "15" → flush buffer แล้ว push ตรง
        if (numBuffer) {
          tokens.push(numBuffer);
          numBuffer = "";
        }
        tokens.push(val);
      } else {
        // tile หลักเดียว → สะสม buffer
        numBuffer += val;
      }
    } else {
      // operator หรือ = → flush buffer
      if (numBuffer) {
        tokens.push(numBuffer);
        numBuffer = "";
      }
      if (val !== "") tokens.push(val);
    }
  }

  if (numBuffer) tokens.push(numBuffer);
  return tokens;
}

function evaluateTokens(tokens) {
  if (tokens.length === 0) return null;
  try {
    const r = parseExpr(tokens, 0);
    return r.pos === tokens.length ? r.value : null;
  } catch {
    return null;
  }
}

export function validateEquation(tiles) {
  if (tiles.length < 3) return false;

  // Tokenize ก่อน เพื่อให้รวม multi-digit ได้ถูกต้อง
  const tokens = tilesToTokens(tiles);
  console.log("[SERVER] tokens:", tokens);

  // หา = ใน tokens
  const equalPositions = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "=") equalPositions.push(i);
  }
  if (equalPositions.length === 0) return false;

  // แยก tokens ตาม =
  const parts = [];
  let lastPos = 0;
  for (const eqPos of equalPositions) {
    const part = tokens.slice(lastPos, eqPos);
    if (part.length === 0) return false;
    parts.push(part);
    lastPos = eqPos + 1;
  }
  const finalPart = tokens.slice(lastPos);
  if (finalPart.length === 0) return false;
  parts.push(finalPart);

  // Evaluate แต่ละส่วน
  const values = parts.map(evaluateTokens);
  if (values.some((v) => v === null)) return false;

  // ทุกส่วนต้องเท่ากัน
  const first = values[0];
  return values.every((v) => Math.abs(v - first) < 0.0001);
}

function parseExpr(tokens, pos) {
  let r = parseTerm(tokens, pos);
  let val = r.value;
  pos = r.pos;
  while (pos < tokens.length && (tokens[pos] === "+" || tokens[pos] === "-")) {
    const op = tokens[pos++];
    const rr = parseTerm(tokens, pos);
    val = op === "+" ? val + rr.value : val - rr.value;
    pos = rr.pos;
  }
  return { value: val, pos };
}

function parseTerm(tokens, pos) {
  let r = parseNum(tokens, pos);
  let val = r.value;
  pos = r.pos;
  while (pos < tokens.length && (tokens[pos] === "×" || tokens[pos] === "÷")) {
    const op = tokens[pos++];
    const rr = parseNum(tokens, pos);
    if (op === "÷") {
      if (rr.value === 0) throw new Error("div0");
      val /= rr.value;
    } else val *= rr.value;
    pos = rr.pos;
  }
  return { value: val, pos };
}

function parseNum(tokens, pos) {
  if (tokens[pos] === "-") {
    const r = parseNum(tokens, pos + 1);
    return { value: -r.value, pos: r.pos };
  }
  if (pos >= tokens.length) throw new Error("end");
  const n = Number(tokens[pos]);
  if (isNaN(n)) throw new Error(`nan:${tokens[pos]}`);
  return { value: n, pos: pos + 1 };
}

function getSeqFromBoard(board, positions, dir) {
  const sorted = [...positions].sort((a, b) =>
    dir === "H" ? a.col - b.col : a.row - b.row,
  );
  let r = sorted[0].row,
    c = sorted[0].col;
  while (
    r > 0 &&
    c > 0 &&
    (dir === "H" ? board[r][c - 1]?.tile : board[r - 1]?.[c]?.tile)
  ) {
    dir === "H" ? c-- : r--;
  }
  const tiles = [];
  while (r < 15 && c < 15 && board[r][c]?.tile) {
    tiles.push(board[r][c].tile);
    dir === "H" ? c++ : r++;
  }
  return tiles;
}

export function validatePlacement(board, placed, isFirstMove) {
  if (!placed.length) return { valid: false, error: "ยังไม่ได้วางเบี้ย" };
  const rows = [...new Set(placed.map((p) => p.row))];
  const cols = [...new Set(placed.map((p) => p.col))];
  if (rows.length > 1 && cols.length > 1)
    return { valid: false, error: "ต้องวางในแนวเดียวกัน" };

  if (isFirstMove) {
    if (!placed.some((p) => p.row === 7 && p.col === 7))
      return { valid: false, error: "การวางครั้งแรกต้องผ่านช่องดาวกลาง" };
  } else {
    const connects = placed.some((p) => {
      return [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
      ].some(([dr, dc]) => {
        const nr = p.row + dr,
          nc = p.col + dc;
        return (
          nr >= 0 &&
          nr < 15 &&
          nc >= 0 &&
          nc < 15 &&
          board[nr][nc].tile &&
          !placed.some((pp) => pp.row === nr && pp.col === nc)
        );
      });
    });
    if (!connects)
      return { valid: false, error: "ต้องเชื่อมต่อกับเบี้ยที่อยู่บนกระดาน" };
  }

  const dir = rows.length === 1 ? "H" : "V";
  const tempBoard = board.map((r) => r.map((c) => ({ ...c })));
  for (const p of placed)
    tempBoard[p.row][p.col] = { ...tempBoard[p.row][p.col], tile: p.tile };

  const equations = [];
  const mainEq = getSeqFromBoard(tempBoard, placed, dir);
  if (mainEq.length >= 3) equations.push(mainEq);

  for (const p of placed) {
    const cross = getSeqFromBoard(tempBoard, [p], dir === "H" ? "V" : "H");
    if (cross.length >= 3) equations.push(cross);
  }

  if (!equations.length)
    return { valid: false, error: "สมการต้องมีอย่างน้อย 3 ตัว" };

  for (const eq of equations) {
    if (!validateEquation(eq)) {
      return {
        valid: false,
        error: `สมการ "${eq.map((t) => getVal(t)).join(" ")}" ไม่ถูกต้อง`,
      };
    }
  }

  return { valid: true, equations };
}

export function calculateScore(board, placed, equations) {
  const tempBoard = board.map((r) => r.map((c) => ({ ...c })));
  for (const p of placed)
    tempBoard[p.row][p.col] = { ...tempBoard[p.row][p.col], tile: p.tile };
  const placedSet = new Set(placed.map((p) => `${p.row},${p.col}`));

  let total = 0;
  for (const eq of equations) {
    const positions = findEqPositions(tempBoard, eq);
    let score = 0,
      mult = 1;
    for (const pos of positions) {
      const cell = tempBoard[pos.row][pos.col];
      const isNew = placedSet.has(`${pos.row},${pos.col}`);
      let pts = cell.tile?.isBlank ? 0 : cell.tile?.points || 0;
      if (isNew) {
        if (cell.type === "TRIPLE_NUM") pts *= 3;
        else if (cell.type === "DOUBLE_NUM" || cell.type === "STAR") pts *= 2;
        if (cell.type === "TRIPLE_EQ") mult = Math.max(mult, 3);
        else if (cell.type === "DOUBLE_EQ") mult = Math.max(mult, 2);
      }
      score += pts;
    }
    total += score * mult;
  }
  if (placed.length === 8) total += 40;
  return total;
}

function findEqPositions(board, tiles) {
  for (const dir of ["H", "V"]) {
    for (let r = 0; r < 15; r++) {
      for (let c = 0; c < 15; c++) {
        const positions = [];
        let ok = true;
        for (let i = 0; i < tiles.length; i++) {
          const nr = dir === "H" ? r : r + i;
          const nc = dir === "H" ? c + i : c;
          if (nr >= 15 || nc >= 15 || !board[nr][nc].tile) {
            ok = false;
            break;
          }
          positions.push({ row: nr, col: nc });
        }
        if (ok && positions.length === tiles.length) {
          if (
            positions.every(
              (pos, i) => board[pos.row][pos.col].tile.id === tiles[i].id,
            )
          )
            return positions;
        }
      }
    }
  }
  return [];
}
