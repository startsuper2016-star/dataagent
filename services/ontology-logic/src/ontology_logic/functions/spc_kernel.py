# -*- coding: utf-8 -*-
"""SPC 统计内核函数体 — 自元枢 ``backend/scripts/spc_kernel.py`` 逐字节搬移。

COMMON / BODY_DETECT / BODY_RANK / BODY_EVIDENCE 四段字符串常量为元枢已验证的
统计内核原样拷贝（COMMON 含 betai/welch_test/chi2_sf/bh_fdr/score_of 等纯 Python
统计工具；三段 BODY 各自拼 COMMON 后由 ontology_logic.core.executor.run_registered
按元枢 inline 模式包裹——``def inline_function(params): result=None; <body>; return
result``——经 UnifiedSandbox 执行）。常量值逐字节一致（SHA-256 校验见
tests/test_spc_functions.py）；除本文件头注释与常量间的原版分段注释横幅外无新增内容。

元枢离线 runner（run_offline / sqlite shim / 其余 BODY_* 函数体）不随迁：
本部署函数内数据访问统一走 apps/api HTTP 回调（D5 契约）。
"""


# =========================================================================
# 共享统计工具（会拼进每个函数体，必须只用 math / 基础内建）
# =========================================================================
COMMON = r'''
def betacf(a, b, x):
    MAXIT, EPS, FPMIN = 200, 3.0e-12, 1.0e-300
    qab = a + b
    qap = a + 1.0
    qam = a - 1.0
    c = 1.0
    d = 1.0 - qab * x / qap
    if abs(d) < FPMIN:
        d = FPMIN
    d = 1.0 / d
    h = d
    for m in range(1, MAXIT + 1):
        m2 = 2 * m
        aa = m * (b - m) * x / ((qam + m2) * (a + m2))
        d = 1.0 + aa * d
        if abs(d) < FPMIN:
            d = FPMIN
        c = 1.0 + aa / c
        if abs(c) < FPMIN:
            c = FPMIN
        d = 1.0 / d
        h *= d * c
        aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
        d = 1.0 + aa * d
        if abs(d) < FPMIN:
            d = FPMIN
        c = 1.0 + aa / c
        if abs(c) < FPMIN:
            c = FPMIN
        d = 1.0 / d
        de = d * c
        h *= de
        if abs(de - 1.0) < EPS:
            break
    return h


def betai(a, b, x):
    """正则化不完全 Beta I_x(a,b)（t 分布 p 值用）。"""
    if x <= 0.0:
        return 0.0
    if x >= 1.0:
        return 1.0
    ln_bt = math.lgamma(a + b) - math.lgamma(a) - math.lgamma(b) + a * math.log(x) + b * math.log(1.0 - x)
    bt = math.exp(ln_bt)
    if x < (a + 1.0) / (a + b + 2.0):
        return bt * betacf(a, b, x) / a
    return 1.0 - bt * betacf(b, a, 1.0 - x) / b


def t_sf2(t, df):
    """双侧 t 检验 p 值。"""
    if df <= 0:
        return 1.0
    x = df / (df + t * t)
    return betai(df / 2.0, 0.5, x)


def gser(a, x):
    ap = a
    s = 1.0 / a
    d = s
    for gi in range(200):
        ap += 1.0
        d *= x / ap
        s += d
        if abs(d) < abs(s) * 1.0e-12:
            break
    return s * math.exp(-x + a * math.log(x) - math.lgamma(a))


def gcf(a, x):
    FPMIN = 1.0e-300
    b = x + 1.0 - a
    c = 1.0 / FPMIN
    d = 1.0 / b
    h = d
    for i in range(1, 200):
        an = -1.0 * i * (i - a)
        b += 2.0
        d = an * d + b
        if abs(d) < FPMIN:
            d = FPMIN
        c = b + an / c
        if abs(c) < FPMIN:
            c = FPMIN
        d = 1.0 / d
        de = d * c
        h *= de
        if abs(de - 1.0) < 1.0e-12:
            break
    return math.exp(-x + a * math.log(x) - math.lgamma(a)) * h


def chi2_sf(x, df):
    """卡方上侧概率 Q(df/2, x/2)。"""
    if x <= 0:
        return 1.0
    a = df / 2.0
    xx = x / 2.0
    if xx < a + 1.0:
        return 1.0 - gser(a, xx)
    return gcf(a, xx)


def welch_test(n1, m1, v1, n2, m2, v2):
    """Welch t 检验：返回 (t, p双侧, cohen_d)。v1/v2 为方差（勿传平方和）。"""
    if n1 < 2 or n2 < 2:
        return 0.0, 1.0, 0.0
    s1, s2 = v1, v2
    se = math.sqrt(s1 / n1 + s2 / n2)
    if se <= 0:
        return 0.0, 1.0, 0.0
    t = (m1 - m2) / se
    df = (s1 / n1 + s2 / n2) ** 2 / ((s1 / n1) ** 2 / (n1 - 1) + (s2 / n2) ** 2 / (n2 - 1))
    sp = math.sqrt(((n1 - 1) * s1 + (n2 - 1) * s2) / (n1 + n2 - 2))
    d = (m1 - m2) / sp if sp > 0 else 0.0
    return t, t_sf2(t, df), d


def bh_fdr(pvals):
    """Benjamini-Hochberg 校正，返回与输入同序的 p_adj 列表。"""
    m = len(pvals)
    order = sorted(range(m), key=lambda i: pvals[i])
    adj = [0.0] * m
    prev = 1.0
    for rank in range(m, 0, -1):
        i = order[rank - 1]
        val = pvals[i] * m / rank
        prev = min(prev, val)
        adj[i] = min(prev, 1.0)
    return adj


def score_of(p_adj, effect, coverage, n):
    s8 = 0.0 if p_adj >= 1.0 else min(1.0, (-math.log10(max(p_adj, 1.0e-300))) / 8.0)
    return round(100 * (0.40 * s8 + 0.30 * min(1.0, abs(effect) / 2.0)
                        + 0.20 * min(1.0, coverage) + 0.10 * min(1.0, n / 200.0)), 1)
'''


# =========================================================================
# S1: spc_detect —— 异常检测锚定
# =========================================================================
BODY_DETECT = COMMON + r'''
# 窗口唯一事实源 = cfg_window（由「应用分析窗口」sql_exec Action 写入）
cfg = query_objects('WindowConfig', {}, 10)[0]
WINDOW_START = cfg['window_start']
case_id = params.get('case_id')
if case_id:
    cs = query_objects('SpcCase', {'case_id': case_id}, 5)
    if not cs:
        raise ValueError('Case 不存在: ' + case_id)
    c0 = cs[0]
    cw, ce = c0.get('window_start'), c0.get('window_end')
    if cw and (cw != WINDOW_START or (ce and ce != cfg.get('window_end'))):
        raise ValueError('Case ' + case_id + ' 声明窗口 ' + str(cw) + '~' + str(ce) +
                         ' 与当前应用窗口 ' + WINDOW_START + '~' + str(cfg.get('window_end')) +
                         ' 不一致，请先执行「应用分析窗口」')

# 基线矩量：对象名 SQL 一次聚合（call_complex_sql，对象名重写+只读白名单），不再依赖 RcaBaseline 视图
base_row = call_complex_sql(
    "SELECT count(*) AS n, sum(rs_ti_mean) AS sum_x, sum(rs_ti_mean * rs_ti_mean) AS sum_x2"
    " FROM WaferFact WHERE process_date < :ws", {"ws": WINDOW_START})["rows"][0]
n0 = base_row[0]
m0 = base_row[1] / n0
var0 = base_row[2] / n0 - m0 * m0
sigma0 = math.sqrt(var0)
ucl = m0 + 3 * sigma0

# 窗口每日检出：filter DSL 范围比较（不再全量拉取后内存过滤）
daily = query_objects('RcaDaily', {'stat_date': {'gte': WINDOW_START}}, 200)
win_days = sorted(daily, key=lambda x: x['stat_date'])
anom_days = [d for d in win_days if d['n_over_ucl'] > 0]

# 异常 Wafer 明细：offset 翻页取全量（单页上限 200）
wafers = []
wafer_offset = 0
while True:
    page = query_objects('AnomWafer', {}, 200, wafer_offset)
    wafers.extend(page)
    if len(page) < 200:
        break
    wafer_offset += 200
lots = sorted(set(w['lot_id'] for w in wafers))
anom_exact = sum(d['n_over_ucl'] for d in win_days)

result = {
    'anchor': {
        'station': 'PVD_TI', 'param_name': params.get('param_name', 'Rs_Ti'),
        'window_start': WINDOW_START,
        'window_end': win_days[-1]['stat_date'] if win_days else None,
        'baseline': {'n': n0, 'mean': round(m0, 4), 'sigma': round(sigma0, 4), 'ucl3': round(ucl, 4)},
        'first_violation_day': anom_days[0]['stat_date'] if anom_days else None,
        'anom_days': len(anom_days),
        'win_wafer_n': sum(d['n'] for d in win_days),
        'anomaly': 'high' if True else 'low',
        'magnitude_sigma': round((max([w['rs_ti_mean'] for w in wafers]) - m0) / sigma0, 2) if wafers else 0,
        'anom_wafer_n': anom_exact,
        'wafer_list_truncated': anom_exact > len(wafers),
        'anom_lot_n': len(lots),
        'anom_lots': lots,
        'rule': 'I-chart 3-sigma (wafer mean, baseline=pre-window 60d)',
    }
}
'''


# =========================================================================
# S2+S3: rca_rank —— 分组检验 / FDC 相关 / FDR / 评分排名
# =========================================================================
BODY_RANK = COMMON + r'''
# 与 spc_detect 同源：窗口读 cfg_window
cfg = query_objects('WindowConfig', {}, 10)[0]
WINDOW_START = cfg['window_start']
candidates = []

# --- 全局矩量：基线 vs 窗口（基线走 call_complex_sql 聚合，不依赖 RcaBaseline 视图）---
base_row = call_complex_sql(
    "SELECT count(*) AS n, sum(rs_ti_mean) AS sum_x, sum(rs_ti_mean * rs_ti_mean) AS sum_x2"
    " FROM WaferFact WHERE process_date < :ws", {"ws": WINDOW_START})["rows"][0]
nb = base_row[0]
mb = base_row[1] / nb
vb = base_row[2] / nb - mb * mb
corr = query_objects('RcaFdcCorr', {}, 5)[0]
nw, mw = corr['n'], corr['sum_y'] / corr['n']
vw = corr['sum_y2'] / corr['n'] - mw * mw

# --- 因子1：腔体检出率（分类，2xK 卡方，异常是否集中于某腔体）---
rates = query_objects('RcaChamberRate', {}, 50)
anom_total = sum(r['win_anom_n'] for r in rates)
win_total = sum(r['win_n'] for r in rates)
p_pool = anom_total / win_total if win_total else 0.0
chi2 = 0.0
for r in rates:
    o1, n1 = r['win_anom_n'], r['win_n']
    o0 = n1 - o1
    e1, e0 = n1 * p_pool, n1 * (1 - p_pool)
    if e1 > 0:
        chi2 += (o1 - e1) ** 2 / e1 + (o0 - e0) ** 2 / e0
k = len(rates)
p_chi = chi2_sf(chi2, k - 1)
v_cramer = math.sqrt(chi2 / win_total) if win_total else 0.0
top_rate_row = max(rates, key=lambda r: r['win_anom_n'])
top_rate = top_rate_row['win_anom_n'] / top_rate_row['win_n'] if top_rate_row['win_n'] else 0.0
candidates.append({
    'factor': top_rate_row['chamber_id'], 'kind': 'categorical', 'dim': 'chamber',
    'test': 'chi2_independence', 'stat': round(chi2, 2), 'df': k - 1,
    'p': p_chi, 'effect': round(v_cramer, 3),
    'detail': '检出率 %.1f%% vs 池化 %.2f%%' % (top_rate * 100, p_pool * 100),
    'coverage': anom_total and top_rate_row['win_anom_n'] / anom_total or 0,
    'n': win_total,
})
rates_concentrate = p_chi < 0.01

# --- 因子2：腔体前后偏移（各腔窗口 vs 各腔自身基线，Welch t，消除选择偏差）---
comps = query_objects('RcaChamberComp', {}, 50)
by_ch = {}
for c in comps:
    by_ch.setdefault(c['chamber_id'], {})[c['grp']] = c
ch_shifts = []
for ch in sorted(by_ch):
    g = by_ch[ch]
    wn, bn = g.get('win'), g.get('base')
    if not wn or not bn or wn['n'] < 5 or bn['n'] < 5:
        continue
    v1 = wn['sum_x2'] / wn['n'] - (wn['sum_x'] / wn['n']) ** 2
    v0 = bn['sum_x2'] / bn['n'] - (bn['sum_x'] / bn['n']) ** 2
    t, p, d = welch_test(wn['n'], wn['sum_x'] / wn['n'], v1, bn['n'], bn['sum_x'] / bn['n'], v0)
    ch_shifts.append({'ch': ch, 't': t, 'p': p, 'd': d, 'n': wn['n'] + bn['n'],
                      'm_win': wn['sum_x'] / wn['n'], 'm_base': bn['sum_x'] / bn['n'],
                      'win_n': wn['n']})

# --- 因子3：FDC RF_Power（异常组 vs 窗口对照组的 case-control 对比）---
fg = {r['grp']: r for r in query_objects('RcaFdcGroup', {}, 10)}
ga, gc = fg.get('anom'), fg.get('ctrl')
if ga and gc and ga['n'] >= 5:
    v1 = ga['sum_x2'] / ga['n'] - (ga['sum_x'] / ga['n']) ** 2
    v0 = gc['sum_x2'] / gc['n'] - (gc['sum_x'] / gc['n']) ** 2
    t, p, d = welch_test(ga['n'], ga['sum_x'] / ga['n'], v1, gc['n'], gc['sum_x'] / gc['n'], v0)
    nn, sx, sy = corr['n'], corr['sum_x'], corr['sum_y']
    r_num = nn * corr['sum_xy'] - sx * sy
    r_den = math.sqrt((nn * corr['sum_x2'] - sx * sx) * (nn * corr['sum_y2'] - sy * sy))
    r = r_num / r_den if r_den > 0 else 0.0
    candidates.append({
        'factor': 'RF_Power_Mean (FDC)', 'kind': 'continuous', 'dim': 'fdc',
        'test': 'welch_t', 'stat': round(t, 3), 'p': p,
        'effect': round(abs(d), 3),
        'detail': '异常组 %.3f vs 对照 %.3f, 窗口内 r=% .2f' % (ga['sum_x'] / ga['n'], gc['sum_x'] / gc['n'], r),
        'direction': 'down' if (ga['sum_x'] / ga['n']) < (gc['sum_x'] / gc['n']) else 'up',
        'coverage': (ga['n'] + gc['n']) and ga['n'] / (ga['n'] + gc['n']) or 0,
        'n': ga['n'] + gc['n'],
    })

# --- 候选裁决：异常集中于腔体→腔体前后偏移；否则全局共同偏移（不甩锅腔体）---
if rates_concentrate:
    for s in sorted(ch_shifts, key=lambda x: -abs(x['d'])):
        if s['p'] < 0.01 and abs(s['d']) >= 0.3:
            candidates.append({
                'factor': s['ch'] + ' 前后偏移', 'kind': 'continuous', 'dim': 'chamber',
                'test': 'welch_t_pre_post', 'stat': round(s['t'], 3), 'p': s['p'],
                'effect': round(abs(s['d']), 3),
                'detail': '窗口均值 %.3f vs 该腔基线 %.3f' % (s['m_win'], s['m_base']),
                'coverage': s['win_n'] and (s['win_n'] / win_total) or 0,
                'n': s['n'],
            })
else:
    t_g, p_g, d_g = welch_test(nw, mw, vw, nb, mb, vb)
    if p_g < 0.01:
        candidates.append({
            'factor': '全站点共同偏移(非腔体特异)', 'kind': 'continuous', 'dim': 'global',
            'test': 'welch_t_pre_post', 'stat': round(t_g, 3), 'p': p_g,
            'effect': round(abs(d_g), 3),
            'detail': '窗口均值 %.3f vs 基线 %.3f，腔体检出率无显著差异' % (mw, mb),
            'coverage': 1.0,
            'n': nw + nb,
        })

# --- 因子4：lot 集中度（信息项，不进检验）---
lots = query_objects('RcaAnomLot', {}, 200)
top_lot = max(lots, key=lambda x: x['anom_n']) if lots else None

# --- FDR 校正与评分 ---
pvals = [cd['p'] for cd in candidates]
padj = bh_fdr(pvals)
for i, cd in enumerate(candidates):
    cd['p_adj'] = padj[i]
    cd['score'] = score_of(padj[i], cd['effect'], cd['coverage'], cd['n'])
candidates.sort(key=lambda x: -x['score'])

result = {
    'ranking': candidates,
    'top1': candidates[0]['factor'] if candidates else None,
    'top_chamber': top_rate_row['chamber_id'],
    'rates_concentrate': rates_concentrate,
    'lot_hint': {'top_lot': top_lot['lot_id'], 'n': top_lot['anom_n'],
                 'concentration': round(top_lot['anom_n'] / max(anom_total, 1), 2)} if top_lot else None,
}
'''


# =========================================================================
# S4+S5: rca_evidence —— 事件证据四维评分 + 置信度门控
# =========================================================================
BODY_EVIDENCE = COMMON + r'''
WINDOW_START = params.get('window_start', '2026-09-21')
WINDOW_END = params.get('window_end', '2026-10-20')
ONSET = params.get('onset', WINDOW_START)
candidates = params.get('candidates') or []
rank_map = {}
for cd in candidates:
    k = cd.get('dim')
    if k not in rank_map or (cd.get('score') or 0) > (rank_map[k].get('score') or 0):
        rank_map[k] = cd
top_dim_score = {}
if candidates:
    by_dim = {}
    for cd in candidates:
        by_dim[cd.get('dim')] = max(by_dim.get(cd.get('dim'), 0), cd.get('score', 0) / 100.0)
    top_dim_score = by_dim

DATE_POS = {'2026-07': 0, '2026-08': 31, '2026-09': 61, '2026-10': 91}

def dayno(s):
    try:
        return DATE_POS[s[:7]] + int(s[8:10])
    except Exception:
        return None

onset_d = dayno(ONSET)
win_end_d = dayno(WINDOW_END)
span = max(1, (win_end_d - onset_d + 1))

DIR_HINTS = {'靶材': 1.0, '换靶': 1.0, '功率': 1.0, '气体': 0.8, '温度': 0.8}
CLEAR_HINTS = ['未复校', '未恢复', '异常', '偏移', '漂移']
ROUTINE_HINTS = ['例行', '定期', '无异常', '常规']

def kw_score(text, hints):
    for k, v in hints.items():
        if k in text:
            return v
    return 0.5

def contains_any(text, words):
    for w in words:
        if w in text:
            return True
    return False

events = query_objects('ToolEvent', {}, 100)
hypotheses = []
for ev in events:
    s_day = dayno(ev['event_start'])
    if s_day is None:
        continue
    e_day = min(dayno(ev['event_end']) or s_day, win_end_d)
    ov0, ov1 = max(s_day - 1, onset_d - 3), min(e_day + 14, win_end_d)
    t_cov = max(0.0, min(1.0, (ov1 - ov0 + 1) / span)) if ov1 >= ov0 else 0.0
    desc = ev['event_desc'] or ''
    d_dir = kw_score(desc, DIR_HINTS)
    ev_ch = ev['chamber_id'] or ''
    d_match = 0.0
    if ev_ch and top_dim_score:
        if ev_ch in str(rank_map.get('chamber', {}).get('factor', '')):
            d_match = 1.0
        else:
            d_match = 0.5 if ev_ch[:5] == str(rank_map.get('chamber', {}).get('factor', ''))[:5] else 0.0
    d_evi = 0.5 if contains_any(desc, ROUTINE_HINTS) else (1.0 if contains_any(desc, CLEAR_HINTS) else 0.3)
    weight = 0.25 * (t_cov + d_dir + d_match + d_evi)
    if d_match >= 0.5:
        stat_norm = top_dim_score.get('chamber', 0.0)
    elif 'chamber' not in top_dim_score and 'global' in top_dim_score:
        stat_norm = top_dim_score.get('global', 0.0) * 0.6
    else:
        stat_norm = top_dim_score.get('fdc', 0.0) * 0.5
    final = 0.6 * stat_norm + 0.4 * weight
    hypotheses.append({
        'event_id': ev['id'], 'event': ev['event_type'] + ' ' + (ev['chamber_id'] or ''),
        'desc': desc, 'chamber': ev_ch,
        'time_cov': round(t_cov, 2), 'dir': d_dir, 'dim_match': d_match, 'evidence': d_evi,
        'evidence_weight': round(weight, 3), 'final_weight': round(final, 3),
    })

hypotheses.sort(key=lambda x: -x['final_weight'])
top = hypotheses[0] if hypotheses else None
conf = top['final_weight'] if top else 0.0
if conf >= 0.70:
    gate, action = 'auto_ticket', '自动开单（置信度≥0.70）'
elif conf >= 0.40:
    gate, action = 'report_only', '仅生成报告，人工审阅（0.40~0.70）'
else:
    gate, action = 'archive', '归档观察（<0.40）'

result = {
    'conclusion': (top['event'] + '：' + top['desc'][:40]) if top else '无候选根因',
    'confidence': round(conf, 3),
    'gate': gate,
    'gate_action': action,
    'hypotheses': hypotheses,
    'disclaimer': '输出为候选根因+证据链，非因果定论；最终根因需工程师结合 OCAP 与机台履历确认。',
}
'''
