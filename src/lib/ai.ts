import { TARGETS } from './config'
import { db, isDemo } from './db'
import { dateStr, nowTime, fmtDate, fmtDateShort, fmt, round, sumFood, type FoodEntry, type WorkoutEntry } from './utils'
import { useAppStore, type ChatApiMessage, type ChatDisplayMessage } from '../store'
import { searchFoodDatabase, safeCalc } from './food-db'
import { openApiKeySheet } from './sheets'

export const CLAUDE_TOOLS = [
  {
    name: 'lookup_food',
    description: 'Search real nutrition databases (USDA FoodData Central for generic/home-cooked foods, Open Food Facts for branded/packaged products including European brands) for per-100g nutrition data. Always call this before estimating calories for log_food, edit_food, or save_meal_preset, unless the user gave explicit calorie numbers or the food exactly matches a saved preset. Returns the closest matches with kcal/protein/carbs/fat per 100g — use calculate to scale to the actual portion.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Food name to search, e.g. "chicken breast cooked"' } },
      required: ['query'],
    },
  },
  {
    name: 'calculate',
    description: 'Evaluate a basic arithmetic expression (+ - * / parentheses) to scale per-100g nutrition data to an actual portion size, or to sum multiple items. Always use this instead of doing the math yourself.',
    input_schema: {
      type: 'object',
      properties: { expression: { type: 'string', description: 'e.g. "165 * 1.5" for a 150g portion of a 110kcal/100g food' } },
      required: ['expression'],
    },
  },
  {
    name: 'log_food',
    description: 'Log a food/drink entry. Works for today or any past date. Use saved meal preset values when the name matches, otherwise use lookup_food + calculate to get real values before logging.',
    input_schema: {
      type: 'object',
      properties: {
        description: { type: 'string' },
        calories: { type: 'number', description: 'kcal' },
        protein: { type: 'number', description: 'grams' },
        carbs: { type: 'number', description: 'grams' },
        fat: { type: 'number', description: 'grams' },
        meal: { type: 'string', enum: ['breakfast', 'lunch', 'snack', 'dinner'] },
        date: { type: 'string', description: 'YYYY-MM-DD — omit for today' },
      },
      required: ['description', 'calories'],
    },
  },
  {
    name: 'edit_food',
    description: 'Edit an existing food entry. Only include fields that should change.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        description: { type: 'string' },
        calories: { type: 'number' },
        protein: { type: 'number' },
        carbs: { type: 'number' },
        fat: { type: 'number' },
        meal: { type: 'string', enum: ['breakfast', 'lunch', 'snack', 'dinner'] },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_food',
    description: 'Delete a food entry by ID.',
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'log_workout',
    description: 'Log an activity for today or any past date.',
    input_schema: {
      type: 'object',
      properties: {
        description: { type: 'string' },
        intensity: { type: 'string', enum: ['low', 'medium', 'high'] },
        calories_burned: { type: 'number', description: 'ACTIVE kcal burned, i.e. above resting metabolism (optional) — see system prompt rules on estimating this' },
        duration_min: { type: 'number', description: 'duration in minutes (optional)' },
        distance_km: { type: 'number', description: 'distance in km (optional)' },
        heart_rate_avg: { type: 'number', description: 'average heart rate in bpm (optional)' },
        date: { type: 'string', description: 'YYYY-MM-DD — omit for today' },
      },
      required: ['description', 'intensity'],
    },
  },
  {
    name: 'edit_workout',
    description: 'Edit an existing activity entry. Only include fields that should change.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        description: { type: 'string' },
        intensity: { type: 'string', enum: ['low', 'medium', 'high'] },
        calories_burned: { type: 'number', description: 'ACTIVE kcal burned, i.e. above resting metabolism' },
        duration_min: { type: 'number' },
        distance_km: { type: 'number' },
        heart_rate_avg: { type: 'number' },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_workout',
    description: 'Delete a workout entry by ID.',
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'log_weight',
    description: 'Log a body weight measurement for today or any past date.',
    input_schema: {
      type: 'object',
      properties: { kg: { type: 'number' }, date: { type: 'string', description: 'YYYY-MM-DD — omit for today' } },
      required: ['kg'],
    },
  },
  {
    name: 'save_meal_preset',
    description: 'Save a food item as a reusable meal preset.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        calories: { type: 'number' },
        protein: { type: 'number', description: 'grams' },
        carbs: { type: 'number', description: 'grams' },
        fat: { type: 'number', description: 'grams' },
        meal: { type: 'string', enum: ['breakfast', 'lunch', 'snack', 'dinner'] },
      },
      required: ['name', 'calories'],
    },
  },
  {
    name: 'set_targets',
    description: "Update the user's daily calorie and macro targets. Only include fields that should change.",
    input_schema: {
      type: 'object',
      properties: {
        cal_rest: { type: 'number', description: 'Rest day calorie target (kcal)' },
        cal_training: { type: 'number', description: 'Training day calorie target (kcal)' },
        protein_g: { type: 'number', description: 'Daily protein target (grams)' },
        carbs_g: { type: 'number', description: 'Daily carbs target (grams)' },
        fat_g: { type: 'number', description: 'Daily fat target (grams)' },
      },
    },
  },
]

function normFood(s: string) {
  return s.toLowerCase()
    .replace(/\b\d+(\.\d+)?\s*(g|ml|oz|x|kg|lb|cup|tbsp|tsp|piece|slice|scoop)s?\b/gi, '')
    .replace(/\b(large|medium|small|big|half|whole|extra)\b/gi, '')
    .replace(/[^a-z ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function frequentFoodsNotPreset(data: { food: Record<string, FoodEntry[]> }, presets: { name: string }[]) {
  const normPresets = new Set(presets.map((p) => normFood(p.name)))
  const counts: Record<string, number> = {}
  const examples: Record<string, FoodEntry> = {}
  for (const entries of Object.values(data.food || {})) {
    for (const e of entries) {
      if (!e.description) continue
      const key = normFood(e.description)
      if (!key) continue
      counts[key] = (counts[key] || 0) + 1
      if (!examples[key]) examples[key] = e
    }
  }
  return Object.entries(counts)
    .filter(([key, n]) => n >= 2 && !normPresets.has(key))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([key, n]) => ({ key, count: n, entry: examples[key] }))
}

export async function buildClaudeSystem() {
  const data = await db.load()
  const meals = (useAppStore.getState().mealsCache || []) as { name: string; calories: number; protein: number; carbs: number; fat: number; meal?: string }[]
  const today = dateStr()
  const food = data.food[today] || []
  const workouts = data.workouts[today] || []
  const totals = sumFood(food)
  const weights = data.weights || []
  const calTarget = TARGETS.calories.goal || TARGETS.calories.rest
  void workouts

  const mealsList = meals.length
    ? meals.map((m) => `  • ${m.name}: ${m.calories} kcal, P${m.protein}g C${m.carbs}g F${m.fat}g (${m.meal || 'snack'})`).join('\n')
    : '  (none saved yet)'

  const recentLines: string[] = []
  for (let i = 0; i < 7; i++) {
    const d = new Date(); d.setDate(d.getDate() - i)
    const ds = dateStr(d)
    const df = data.food[ds] || []
    const dw = data.workouts[ds] || []
    if (!df.length && !dw.length) continue
    recentLines.push(`${fmtDateShort(ds)}${i === 0 ? ' (today)' : ''}:`)
    df.forEach((e) => recentLines.push(`  food     [${e.id}] ${e.description} — ${round(e.calories)} kcal (${e.meal || 'snack'})`))
    dw.forEach((e) => recentLines.push(`  workout  [${e.id}] ${e.description} (${e.intensity})${e.calories_burned ? ' ' + e.calories_burned + ' kcal burned' : ''}`))
  }

  const burnedToday = (data.workouts[today] || []).reduce((s, w) => s + (w.calories_burned || 0), 0)
  const eatbackPct = TARGETS.calories.eatback_enabled !== false ? (TARGETS.calories.eatback_pct ?? 50) : 0
  const eatback = burnedToday > 0 ? Math.round(burnedToday * eatbackPct / 100) : 0
  const effectiveTarget = calTarget + eatback

  const frequent = frequentFoodsNotPreset(data, meals)
  const autoSave = frequent.filter((f) => f.count >= 3)
  const suggest = frequent.filter((f) => f.count === 2)
  const autoSaveSection = autoSave.length
    ? `\nAUTO-SAVE REQUIRED — call save_meal_preset immediately for each of these (logged 3+ times, not yet a preset):\n${autoSave.map((f) => `  • "${f.entry.description}" x${f.count} — cal:${round(f.entry.calories)} P:${round(f.entry.protein)}g C:${round(f.entry.carbs)}g F:${round(f.entry.fat)}g meal:${f.entry.meal || 'snack'}`).join('\n')}`
    : ''
  const suggestSection = suggest.length
    ? `\nFrequently logged but not yet preset (logged 2 times — suggest saving): ${suggest.map((f) => `"${f.entry.description}"`).join(', ')}`
    : ''

  return `You are a concise fitness tracking assistant embedded in the user's personal tracker app.
Today: ${fmtDate(today)} (${today})
Calories today: ${round(totals.calories)} / ${effectiveTarget} kcal (${round(effectiveTarget - totals.calories)} remaining)${burnedToday > 0 ? ` [burned ${burnedToday} kcal, eating back ${eatbackPct}% = +${eatback} kcal]` : ''}
Protein: ${fmt(totals.protein)}g / ${TARGETS.protein}g  Carbs: ${fmt(totals.carbs)}g / ${TARGETS.carbs}g  Fat: ${fmt(totals.fat)}g / ${TARGETS.fat}g
Current targets: goal ${calTarget} kcal + ${eatback} eat-back = ${effectiveTarget} kcal today / P${TARGETS.protein}g C${TARGETS.carbs}g F${TARGETS.fat}g
Latest weight: ${weights[0] ? weights[0].kg.toFixed(1) + ' kg (' + fmtDateShort(weights[0].date) + ')' : 'not logged'}

Recent log (last 7 days) — use IDs to edit or delete:
${recentLines.length ? recentLines.join('\n') : '  (empty)'}

Saved meal presets:
${mealsList}
${autoSaveSection}${suggestSection}
Rules:
- Log food/workouts/weight for ANY date the user mentions. Use YYYY-MM-DD format.
  Current targets: maintenance ${TARGETS.calories.rest} kcal / goal ${TARGETS.calories.goal || TARGETS.calories.rest} kcal / P${TARGETS.protein}g C${TARGETS.carbs}g F${TARGETS.fat}g / BMR ${TARGETS.calories.bmr || 1800} kcal/day
- You may call multiple tools in one turn (e.g. lookup_food + calculate + log_food together).
- This app tracks workout calories_burned as ACTIVE calories only (burn above resting metabolism), never total/gross burn — eat-back math depends on this. If the user gives an explicit calories_burned number, log it as-is. If you're estimating it yourself (no number given), estimate the realistic TOTAL/gross burn for that activity and duration first, then use calculate to subtract resting calories for that duration (BMR ÷ 1440 × duration_min) before calling log_workout — the same conversion this app already applies to Strava imports.
- Before calling log_food, edit_food, or save_meal_preset for any food whose calories the user did NOT explicitly state, and that doesn't exactly match a saved preset above: first call lookup_food, then call calculate to scale the matched per-100g values to the actual portion eaten. Never invent calorie/macro numbers from memory when these tools are available.
- If lookup_food returns no usable match or a rate-limited error, call it at most once for that food — do not retry with a reworded/rephrased query. Just say so and estimate from context as a last resort.
- If a message describes several food items and you're missing real details for only some of them (e.g. an unclear portion, an ambiguous ingredient, a homemade dish with no obvious recipe), log the items you can confidently determine right away, then ask about just the remaining ones in your reply. Never hold back logging everything just because one item needs a follow-up question.
- If the AUTO-SAVE REQUIRED section lists any foods, call save_meal_preset for each one in this response — do not wait, do not ask. These are unrelated to whatever the user just asked, so always say in your reply that you saved it as a preset and why (logged a few times already) — never save one silently without mentioning it, even if it means a slightly longer reply.
- For foods in the suggest section, mention once that they could be saved as a preset (one short sentence).
- Reply exactly like a text message to a friend: plain prose only, 1-2 sentences max. Never use markdown formatting of any kind — no **bold**, no _italics_, no tables, no bullet/numbered lists, no headers, no code blocks, no backticks, no em dashes. Never use emoji (no 🔥 😊 etc) — if you want to express tone, use a plain-text emoticon instead, like :) :( :0 ;) or similar. Plain words, punctuation, and the occasional emoticon, every single reply, no exceptions.`
}

const DEMO_REPLIES = [
  "Got it, logged that for you!",
  "Nice, that fits well within today's targets.",
  "Saved! Let me know if there's anything else to log.",
  "Logged it. You're tracking well today.",
  "Done — that's noted in your log now.",
]

const DEMO_WISDOM = [
  "You're averaging a solid protein intake this week — keep it up.",
  "Training days look well balanced against your rest days.",
  "Your calorie logging has been consistent for the past week, nice work.",
  "Protein intake is trending close to your target most days.",
  "Activity levels are steady — a good rhythm to maintain this week.",
]

export async function fetchDailyWisdom(): Promise<string | null> {
  const currentUser = useAppStore.getState().currentUser
  if (!currentUser) return null

  const today = dateStr()
  const cacheKey = `tracker-wisdom-${currentUser.id}`
  try {
    const cached = JSON.parse(localStorage.getItem(cacheKey) || 'null')
    if (cached?.date === today) return cached.text
  } catch { /* ignore */ }

  if (isDemo) {
    const text = DEMO_WISDOM[Math.floor(Math.random() * DEMO_WISDOM.length)]
    try { localStorage.setItem(cacheKey, JSON.stringify({ date: today, text })) } catch { /* ignore */ }
    return text
  }

  const key = localStorage.getItem('tracker-anthropic-key') || ''
  if (!key) return null

  const data = await db.load()
  const weights = data.weights || []

  const days: { ds: string; food: FoodEntry[]; workouts: WorkoutEntry[]; cal: number; pro: number; carbs: number; fat: number }[] = []
  for (let i = 0; i < 7; i++) {
    const d = new Date(); d.setDate(d.getDate() - i)
    const ds = dateStr(d)
    const food = data.food[ds] || []
    const workouts = data.workouts[ds] || []
    const t = sumFood(food)
    days.push({ ds, food, workouts, cal: t.calories, pro: t.protein, carbs: t.carbs, fat: t.fat })
  }

  const loggedDays = days.filter((d) => d.food.length > 0)
  const avgCal = loggedDays.length ? round(loggedDays.reduce((s, d) => s + d.cal, 0) / loggedDays.length) : 0
  const avgPro = loggedDays.length ? round(loggedDays.reduce((s, d) => s + d.pro, 0) / loggedDays.length) : 0
  const avgCarb = loggedDays.length ? round(loggedDays.reduce((s, d) => s + d.carbs, 0) / loggedDays.length) : 0
  const avgFat = loggedDays.length ? round(loggedDays.reduce((s, d) => s + d.fat, 0) / loggedDays.length) : 0
  const workoutDays = days.filter((d) => d.workouts.length > 0).length

  const activityLog = days
    .filter((d) => d.workouts.length > 0)
    .map((d) => {
      const acts = d.workouts.map((w) => {
        const parts = [w.description, w.intensity]
        if (w.duration_min) parts.push(`${w.duration_min}min`)
        if (w.calories_burned) parts.push(`${w.calories_burned}kcal burned`)
        if (w.distance_km) parts.push(`${w.distance_km}km`)
        return parts.join(' ')
      }).join(', ')
      return `${fmtDateShort(d.ds)}: ${acts}`
    }).join('\n') || 'none'

  const weightLine = weights.length >= 2
    ? `Weight: ${weights[0].kg.toFixed(1)} kg now vs ${weights[Math.min(weights.length - 1, 6)].kg.toFixed(1)} kg ${Math.min(weights.length - 1, 6)} entries ago`
    : weights.length === 1 ? `Weight: ${weights[0].kg.toFixed(1)} kg (only one reading)` : 'Weight: not logged'

  const prompt = `You are a concise health insight generator. Given 7 days of tracking data, output ONE specific observation the user should know. Pick the single most useful insight from: goal adherence, nutrition trends, protein/calorie gaps, training frequency, activity variety, training load/intensity, rest vs training balance, weight trend.

Today: ${fmtDate(today)}
Targets: ${TARGETS.calories.rest} kcal maintenance / ${TARGETS.calories.goal || TARGETS.calories.rest} kcal goal / P${TARGETS.protein}g C${TARGETS.carbs}g F${TARGETS.fat}g
7-day nutrition averages (${loggedDays.length} days logged): ${avgCal} kcal / P${avgPro}g C${avgCarb}g F${avgFat}g
Workout days in last 7: ${workoutDays}/7
Activity log:
${activityLog}
${weightLine}
Today logged: ${days[0].cal} kcal / P${days[0].pro}g C${days[0].carbs}g F${days[0].fat}g, ${days[0].workouts.length} workout(s)

Rules: one sentence, no markdown, no em dashes, no emojis, no lists, strictly informative, write like a short text message.`

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 80,
        system: prompt,
        messages: [{ role: 'user', content: 'Give me one insight.' }],
      }),
    })
    if (!r.ok) return null
    const msg = await r.json()
    const text = msg.content.find((b: { type: string }) => b.type === 'text')?.text?.trim() || null
    if (text) localStorage.setItem(cacheKey, JSON.stringify({ date: today, text }))
    return text
  } catch { return null }
}

let _abortController: AbortController | null = null
export const isChatLoading = () => _abortController !== null
export function abortChat() {
  if (_abortController) {
    _abortController.abort()
    _abortController = null
  }
}

interface ClaudeContentBlock {
  type: string
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
}
interface ClaudeMessage { content: ClaudeContentBlock[] }

interface ClaudeTool { name: string; description: string; input_schema: Record<string, unknown> }

export async function callClaudeApi(messages: ChatApiMessage[], system: string, signal: AbortSignal, tools: ClaudeTool[] = CLAUDE_TOOLS): Promise<ClaudeMessage> {
  const key = localStorage.getItem('tracker-anthropic-key') || ''
  if (!key) { openApiKeySheet(); throw new Error('No API key') }
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 512, system, tools, messages }),
    signal,
  })
  if (!r.ok) {
    const err = await r.json().catch(() => ({}))
    throw new Error(err?.error?.message || `API error ${r.status}`)
  }
  return r.json()
}

function thinkingVerb() {
  return 'Thinking'
}

function toolCallLabel(tc: ClaudeContentBlock) {
  switch (tc.name) {
    case 'lookup_food': return `Checking food database for "${tc.input?.query || '…'}"`
    case 'calculate': return 'Calculating'
    case 'log_food': return `Logging "${tc.input?.description || 'food'}"`
    case 'edit_food': return 'Updating food entry'
    case 'delete_food': return 'Deleting food entry'
    case 'log_workout': return `Logging "${tc.input?.description || 'activity'}"`
    case 'edit_workout': return 'Updating activity'
    case 'delete_workout': return 'Deleting activity'
    case 'log_weight': return 'Logging weight'
    case 'save_meal_preset': return `Saving "${tc.input?.name || 'meal'}" as preset`
    case 'set_targets': return 'Updating targets'
    default: return 'Working'
  }
}

const TOOL_GROUP_LABEL: Record<string, string> = {
  lookup_food: 'Checking food database',
  log_food: 'Logging food',
  edit_food: 'Updating food entries',
  delete_food: 'Deleting food entries',
  log_workout: 'Logging activities',
  edit_workout: 'Updating activities',
  delete_workout: 'Deleting activities',
  log_weight: 'Logging weight',
  save_meal_preset: 'Saving presets',
  set_targets: 'Updating targets',
}

interface ExecutedTool { tc: ClaudeContentBlock; content: string }

function groupToolCalls(executed: ExecutedTool[]) {
  const order: string[] = []
  const groups = new Map<string, { count: number; failed: boolean; tc: ClaudeContentBlock }>()
  for (const { tc, content } of executed) {
    const name = tc.name!
    if (!groups.has(name)) { groups.set(name, { count: 0, failed: false, tc }); order.push(name) }
    const g = groups.get(name)!
    g.count++
    g.failed = g.failed || toolCallFailed(name, content)
  }
  return order.map((name) => {
    const g = groups.get(name)!
    const label = g.count > 1 ? `${TOOL_GROUP_LABEL[name] || 'Working'} (${g.count} items)` : toolCallLabel(g.tc)
    return { label, status: g.failed ? ('fail' as const) : ('ok' as const) }
  })
}

// Same grouping as groupToolCalls, but built from the raw tool_use blocks
// before they're executed — shown immediately so the user sees which tool
// is running live, rather than only after the network call resolves.
function groupToolCallsPending(toolCalls: ClaudeContentBlock[]) {
  const order: string[] = []
  const groups = new Map<string, { count: number; tc: ClaudeContentBlock }>()
  for (const tc of toolCalls) {
    const name = tc.name!
    if (SILENT_TOOLS.has(name)) continue
    if (!groups.has(name)) { groups.set(name, { count: 0, tc }); order.push(name) }
    groups.get(name)!.count++
  }
  return order.map((name) => {
    const g = groups.get(name)!
    const label = g.count > 1 ? `${TOOL_GROUP_LABEL[name] || 'Working'} (${g.count} items)` : toolCallLabel(g.tc)
    return { label, status: 'pending' as const }
  })
}

function toolCallFailed(name: string, resultContent: string) {
  if (typeof resultContent === 'string' && resultContent.startsWith('error:')) return true
  if (name === 'lookup_food') {
    try { return !!JSON.parse(resultContent)?.error } catch { return false }
  }
  return false
}

const SILENT_TOOLS = new Set(['calculate'])

function logClaudeRound(round: number, msg: ClaudeMessage, executed: ExecutedTool[]) {
  console.groupCollapsed(`[claude] round ${round + 1}`)
  for (const block of msg.content) {
    if (block.type === 'text') console.log('text:', block.text)
  }
  for (const { tc, content } of executed) {
    console.log(`tool_use: ${tc.name}`, tc.input, '->', content)
  }
  console.groupEnd()
}

export async function executeTool(name: string, input: Record<string, unknown>): Promise<string> {
  const date = (input.date as string) || dateStr()
  try {
    if (name === 'lookup_food') return JSON.stringify(await searchFoodDatabase(input.query as string))
    if (name === 'calculate') {
      try { return String(safeCalc(input.expression as string)) } catch { return 'error: invalid expression' }
    }
    if (name === 'log_food') {
      await db.addFood(date, {
        description: input.description as string, calories: (input.calories as number) || 0,
        protein: (input.protein as number) || 0, carbs: (input.carbs as number) || 0, fat: (input.fat as number) || 0,
        meal: (input.meal as string) || 'snack',
      })
      db.bust()
      return `logged for ${date}`
    }
    if (name === 'edit_food') {
      const fields: Partial<FoodEntry> = {}
      if (input.description !== undefined) fields.description = input.description as string
      if (input.calories !== undefined) fields.calories = input.calories as number
      if (input.protein !== undefined) fields.protein = input.protein as number
      if (input.carbs !== undefined) fields.carbs = input.carbs as number
      if (input.fat !== undefined) fields.fat = input.fat as number
      if (input.meal !== undefined) fields.meal = input.meal as string
      await db.updateFood(input.id as string, fields)
      db.bust()
      return 'updated'
    }
    if (name === 'delete_food') { await db.deleteFood(input.id as string); db.bust(); return 'deleted' }
    if (name === 'log_workout') {
      await db.addWorkout(date, {
        description: input.description as string, intensity: input.intensity as string,
        calories_burned: (input.calories_burned as number) || undefined, duration_min: (input.duration_min as number) || undefined,
        distance_km: (input.distance_km as number) || null, heart_rate_avg: (input.heart_rate_avg as number) || undefined,
        time: nowTime(),
      })
      db.bust()
      return `logged for ${date}`
    }
    if (name === 'edit_workout') {
      const fields: Partial<WorkoutEntry> = {}
      if (input.description !== undefined) fields.description = input.description as string
      if (input.intensity !== undefined) fields.intensity = input.intensity as string
      if (input.calories_burned !== undefined) fields.calories_burned = input.calories_burned as number
      if (input.duration_min !== undefined) fields.duration_min = input.duration_min as number
      if (input.distance_km !== undefined) fields.distance_km = input.distance_km as number
      if (input.heart_rate_avg !== undefined) fields.heart_rate_avg = input.heart_rate_avg as number
      await db.updateWorkout(input.id as string, fields)
      db.bust()
      return 'updated'
    }
    if (name === 'delete_workout') { await db.deleteWorkout(input.id as string); db.bust(); return 'deleted' }
    if (name === 'log_weight') { await db.upsertWeight({ kg: input.kg as number, date }); db.bust(); return `logged for ${date}` }
    if (name === 'save_meal_preset') {
      await db.addMeal({
        name: input.name as string, calories: (input.calories as number) || 0, protein: (input.protein as number) || 0,
        carbs: (input.carbs as number) || 0, fat: (input.fat as number) || 0, meal: (input.meal as string) || 'snack',
      })
      useAppStore.setState({ mealsCache: null })
      return `saved "${input.name}" as meal preset`
    }
    if (name === 'set_targets') {
      if (input.cal_rest !== undefined) TARGETS.calories.rest = input.cal_rest as number
      if (input.cal_training !== undefined) TARGETS.calories.training = input.cal_training as number
      if (input.protein_g !== undefined) TARGETS.protein = input.protein_g as number
      if (input.carbs_g !== undefined) TARGETS.carbs = input.carbs_g as number
      if (input.fat_g !== undefined) TARGETS.fat = input.fat_g as number
      await db.saveSettings({ cal_rest: TARGETS.calories.rest, cal_training: TARGETS.calories.training, protein_g: TARGETS.protein, carbs_g: TARGETS.carbs, fat_g: TARGETS.fat })
      return 'targets updated'
    }
    return `unknown tool: ${name}`
  } catch (e) { return `error: ${(e as Error).message}` }
}

function setChatDisplay(updater: (prev: ChatDisplayMessage[]) => ChatDisplayMessage[]) {
  useAppStore.setState((s) => ({ chatDisplay: updater(s.chatDisplay) }))
}

function chatStorageKey() {
  const u = useAppStore.getState().currentUser
  return u ? `tracker-chat:${u.id}` : null
}

function persistChat() {
  const key = chatStorageKey()
  if (!key) return
  try {
    const { chatDisplay, chatApiMessages } = useAppStore.getState()
    localStorage.setItem(key, JSON.stringify({ display: chatDisplay, api: chatApiMessages, ts: Date.now() }))
  } catch { /* storage full/unavailable — chat just won't survive a refresh */ }
}

const CHAT_TTL_MS = 60 * 60 * 1000

export function restoreChatIfFresh() {
  const key = chatStorageKey()
  if (!key) return
  let saved: { display?: ChatDisplayMessage[]; api?: ChatApiMessage[]; ts: number } | null
  try { saved = JSON.parse(localStorage.getItem(key) || 'null') } catch { return }
  if (!saved) return
  if (Date.now() - saved.ts > CHAT_TTL_MS) { localStorage.removeItem(key); return }

  const display = (saved.display || []).filter((m) => !(m.role === 'assistant' && m.thinking))
  useAppStore.setState({
    chatDisplay: display,
    chatApiMessages: saved.api || [],
    chatPanelState: display.length ? 'peek' : 'collapsed',
  })
}

export function clearChat() {
  const key = chatStorageKey()
  useAppStore.setState({ chatApiMessages: [], chatDisplay: [], chatPanelState: 'collapsed' })
  if (key) localStorage.removeItem(key)
}

export async function sendChatMessage(text: string, images: { data: string; mediaType: string }[] = []) {
  text = text.trim()
  if (!text && !images.length) return

  const displayText = text || '(image)'
  setChatDisplay((prev) => [...prev, { role: 'user', text: displayText, imageCount: images.length || undefined }])

  let apiContent: unknown
  if (images.length) {
    apiContent = [
      ...images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } })),
      { type: 'text', text: text || 'What do you see in this image?' },
    ]
  } else {
    apiContent = text
  }
  useAppStore.setState((s) => ({ chatApiMessages: [...s.chatApiMessages, { role: 'user', content: apiContent }] }))
  setChatDisplay((prev) => [...prev, { role: 'assistant', text: thinkingVerb() + '…', thinking: true }])
  useAppStore.setState({ chatPending: true })

  _abortController = new AbortController()
  const signal = _abortController.signal

  if (isDemo) {
    try {
      const delayMs = 600 + Math.random() * 2400
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, delayMs)
        signal.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')) })
      })
      setChatDisplay((prev) => [...prev.slice(0, -1), { role: 'assistant', text: DEMO_REPLIES[Math.floor(Math.random() * DEMO_REPLIES.length)] }])
    } catch (e) {
      setChatDisplay((prev) => prev.slice(0, -1))
      if ((e as Error).name !== 'AbortError') setChatDisplay((prev) => [...prev, { role: 'assistant', text: (e as Error).message }])
    } finally {
      _abortController = null
      useAppStore.setState({ chatPending: false })
    }
    persistChat()
    return
  }

  try {
    const system = await buildClaudeSystem()
    let replyText = ''
    let currentMessages = useAppStore.getState().chatApiMessages

    let lookupCount = 0
    const LOOKUP_CAP = 6

    for (let round = 0; round < 5; round++) {
      const msg = await callClaudeApi(currentMessages, system, signal)
      const toolCalls = msg.content.filter((b) => b.type === 'tool_use')
      replyText = msg.content.find((b) => b.type === 'text')?.text || ''

      if (!toolCalls.length) {
        logClaudeRound(round, msg, [])
        useAppStore.setState((s) => ({ chatApiMessages: [...s.chatApiMessages, { role: 'assistant', content: msg.content }] }))
        break
      }

      // Show which tools are about to run immediately, before executing them,
      // so the user sees live activity instead of just "Thinking…" the whole
      // time a lookup/calculation is in flight.
      const pending = groupToolCallsPending(toolCalls)
      if (pending.length) {
        setChatDisplay((prev) => {
          const idx = prev.length - 1
          const last = prev[idx]
          if (last?.role === 'assistant' && last.thinking) {
            const next = [...prev]
            next[idx] = { role: 'tool', items: pending }
            return next
          }
          return prev
        })
      }

      const executed: ExecutedTool[] = await Promise.all(toolCalls.map(async (tc) => {
        if (tc.name === 'lookup_food' && ++lookupCount > LOOKUP_CAP) {
          return { tc, content: 'error: lookup limit reached for this message — stop retrying, estimate this item from context instead' }
        }
        return { tc, content: String(await executeTool(tc.name!, tc.input || {})) }
      }))
      logClaudeRound(round, msg, executed)

      const visible = executed.filter(({ tc }) => !SILENT_TOOLS.has(tc.name!))
      setChatDisplay((prev) => {
        const idx = prev.length - 1
        const last = prev[idx]
        if (last?.role === 'tool') {
          const next = [...prev]
          next[idx] = { role: 'tool', items: groupToolCalls(visible) }
          next.push({ role: 'assistant', text: thinkingVerb() + '…', thinking: true })
          return next
        }
        return prev
      })

      const toolResults = executed.map(({ tc, content }) => ({ type: 'tool_result', tool_use_id: tc.id, content }))
      useAppStore.setState((s) => ({
        chatApiMessages: [...s.chatApiMessages, { role: 'assistant', content: msg.content }, { role: 'user', content: toolResults }],
      }))
      currentMessages = useAppStore.getState().chatApiMessages
    }

    setChatDisplay((prev) => {
      const next = prev.slice(0, -1)
      if (replyText) next.push({ role: 'assistant', text: replyText })
      return next
    })
  } catch (e) {
    setChatDisplay((prev) => prev.slice(0, -1))
    if ((e as Error).name !== 'AbortError') {
      setChatDisplay((prev) => [...prev, { role: 'assistant', text: (e as Error).message }])
    }
  } finally {
    _abortController = null
    useAppStore.setState({ chatPending: false })
  }

  // Auto-peek to show the latest assistant reply unless already expanded/explicitly collapsed.
  const state = useAppStore.getState()
  const lastAssistant = [...state.chatDisplay].reverse().find((m) => m.role === 'assistant')
  if (lastAssistant && state.chatPanelState !== 'expanded' && state.chatPanelState !== 'collapsed') {
    useAppStore.setState({ chatPanelState: 'peek' })
  }
  persistChat()
}

export function openChat(initialText: string, images: { data: string; mediaType: string }[] = []) {
  const key = localStorage.getItem('tracker-anthropic-key') || ''
  if (!key && !isDemo) { openApiKeySheet(); return Promise.resolve() }
  if (initialText || images.length) {
    useAppStore.setState({ chatPanelState: 'peek' })
    return sendChatMessage(initialText, images)
  }
  return Promise.resolve()
}

export interface NutritionEstimate { calories: number; protein: number; carbs: number; fat: number }

const NUTRITION_ESTIMATE_TOOLS: ClaudeTool[] = [
  ...CLAUDE_TOOLS.filter((t) => t.name === 'lookup_food' || t.name === 'calculate'),
  {
    name: 'submit_nutrition_estimate',
    description: 'Submit the final total nutrition estimate for the described food. Call this exactly once, as the last step, after using lookup_food and calculate to determine real values scaled to the portion(s) described.',
    input_schema: {
      type: 'object',
      properties: {
        calories: { type: 'number', description: 'total kcal' },
        protein: { type: 'number', description: 'total grams' },
        carbs: { type: 'number', description: 'total grams' },
        fat: { type: 'number', description: 'total grams' },
      },
      required: ['calories', 'protein', 'carbs', 'fat'],
    },
  },
]

const NUTRITION_ESTIMATE_SYSTEM = `You are a nutrition estimator. Given a short food description — possibly with a quantity or portion (e.g. "2 eggs", "200g chicken breast"), or multiple items (e.g. "pasta pesto + 2 eggs") — determine the TOTAL calories and macros (protein, carbs, fat in grams) across everything described.

First, reason about the description yourself: split it into its distinct food items, and for each one work out a clean search query — just the food name, stripped of quantities, portions, and joining words ("2", "200g", "and", "+", "a", "small", etc). E.g. for "2 eggs and toast", search "egg" and "toast" separately, never the raw phrase "2 eggs and toast" as one query. For "large chicken caesar salad", consider searching "chicken breast" and "caesar salad" or "romaine lettuce" separately if that gets better matches than one broad query.

For each item, call lookup_food with that clean query to get real per-100g data (USDA FoodData Central, then Open Food Facts), then call calculate to scale it to the actual portion/quantity described. Sum across multiple items yourself before submitting. Never invent numbers from memory when lookup_food is available.
If lookup_food returns no usable match for an item after one try, do not retry with a reworded query — estimate that item from context as a last resort.
When you have the final totals, call submit_nutrition_estimate exactly once. Do not reply with any other text.`

function demoNutritionEstimate(description: string): NutritionEstimate {
  let seed = 0
  for (const ch of description) seed += ch.charCodeAt(0)
  const rnd = (min: number, max: number, salt: number) => min + ((seed * salt) % (max - min))
  return { calories: rnd(180, 650, 7), protein: rnd(8, 35, 13), carbs: rnd(15, 70, 17), fat: rnd(5, 30, 23) }
}

// Standalone one-shot estimate (not part of the persisted chat conversation)
// used by the wand button in FoodSheet to auto-fill macros from a
// description, reusing the same lookup_food/calculate tools Claude uses
// when logging food from chat.
export async function estimateNutritionFromDescription(description: string): Promise<NutritionEstimate | null> {
  const trimmed = description.trim()
  if (!trimmed) return null

  if (isDemo) {
    await new Promise((r) => setTimeout(r, 500 + Math.random() * 700))
    return demoNutritionEstimate(trimmed)
  }

  const key = localStorage.getItem('tracker-anthropic-key') || ''
  if (!key) { openApiKeySheet(); return null }

  let messages: ChatApiMessage[] = [{ role: 'user', content: `Estimate total nutrition for: ${trimmed}` }]
  const controller = new AbortController()

  for (let round = 0; round < 5; round++) {
    const msg = await callClaudeApi(messages, NUTRITION_ESTIMATE_SYSTEM, controller.signal, NUTRITION_ESTIMATE_TOOLS)
    const toolCalls = msg.content.filter((b) => b.type === 'tool_use')
    const submit = toolCalls.find((b) => b.name === 'submit_nutrition_estimate')
    if (submit) {
      const input = (submit.input || {}) as Record<string, unknown>
      return {
        calories: Math.round(Number(input.calories) || 0),
        protein: Math.round(Number(input.protein) || 0),
        carbs: Math.round(Number(input.carbs) || 0),
        fat: Math.round(Number(input.fat) || 0),
      }
    }
    if (!toolCalls.length) return null

    const executed = await Promise.all(toolCalls.map(async (tc) => ({ tc, content: String(await executeTool(tc.name!, tc.input || {})) })))
    const toolResults = executed.map(({ tc, content }) => ({ type: 'tool_result', tool_use_id: tc.id, content }))
    messages = [...messages, { role: 'assistant', content: msg.content }, { role: 'user', content: toolResults }]
  }
  return null
}
