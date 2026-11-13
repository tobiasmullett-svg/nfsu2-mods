/* tunepresets.c -- Performance Tuning / Dyno: a setup the player never touched
 * opens with a preset for its kind of race (tune_presets = on,
 * NFSU2_TUNE_PRESETS=on; off by default: the original's, every slider in the
 * middle).  tune_presets = always: every setup, each time it opens, takes the
 * preset's values (those the preset sets; the others stay the player's), for
 * trying presets whose shares change (NFSU2_TUNE_<KIND>, below).
 *
 * The game (SPEED2.EXE v1.2 NA).  A setup is 0x29 bytes, each 100 in the
 * middle and 0..200 (dyno.c: the car's record keeps 5, 0 circuit and sprint,
 * 1 drag, 2 drift, 3 Street X, 4 URL; the dyno's visit a copy of them, at the
 * dyno +0x904).  Its values, by their number (0x59AFE0 sets them to 100,
 * 0x59AF80 one from -1..1):
 *   0..3   front springs, shocks, sway bar, lowering; 4..7 the rear's
 *   8      steering ratio
 *   9      final drive; 0xA..0xF gears 1 to 6
 *   0x10, 0x11  nitrous: one slider, the two always 200 together (140 and 60
 *          as Street X's and URL's setups come, 150 and 50 pushed right)
 *   0x12   brake bias; 0x13, 0x14 front and rear tyre grip (100 is all the
 *          grip the tyres have: the slider only takes some away)
 *   0x15, 0x16  front and rear downforce
 *   0x17   9 bytes at +0x17: the ECU's curve, a byte per 1000 rpm; 0x18 9
 *          bytes at +0x20: the turbo's.  A dot moved on their graph moves
 *          the others the other way (the first dot of the ECU's to its top
 *          left 136 109 110 87 86 86 86 87 88): the graph's own doing
 *          (tunegraph.c), so the presets leave both curves alone
 * (0, 1, 2, 3, 8, 0x10, 0x12 to 0x15 and the curves from a player's saves:
 * each slider pushed to its end alone in a setup of its own, which left 125,
 * 113, 113, 186, 150, 150 and 135 pushed right on a Peugeot 106, and 42, 0
 * and 0 for the bias and the grips pushed left; the rear's four from the
 * code, which treats 3 and 7 alike; the gears from 0x59B080, which allows
 * 0xA + n only on a gearbox of more than n gears.)  How far a slider goes depends on the car's parts: the
 * tuning object (a ride's +0x384: the setup at its +0x14, the dyno's at
 * [0x83A540]) answers a value's scale (0x5B0BD0 and 0x5B0C00: springs 0 to
 * 10, lowering -1.3 to 0.12 in), what of it the car's parts reach (0x5B2BD0
 * and 0x5B2BA0) and what the setup's byte gives (0x5B3E40), each in the
 * slider's own unit, and whether the car's parts allow it at all (0x59B080).
 *
 * 0x50FC60 (the kind) loads a kind's setup from the visit's copy into the
 * one being tuned (Mode Select and the tuning screen's start).  Here, before
 * it does, a copy that is as the game makes it (untouched) takes the preset:
 * each value of PRESETS a share of the way from where it stands to the
 * slider's end (+1 the most, -1 the least), found by trying the byte's 201
 * values in the tuning object and keeping the nearest inside the slider's
 * range.  From there on it is a setup like any other: the sliders show it,
 * the player moves them, and Quit Tuning or Save Profile keep it in the car
 * (dyno.c).  A setup with any value of the player's own is left alone; the
 * dyno's own reset of a setup brings the preset back at its next load.
 * The gears and the two curves stay as they come.
 *
 * A kind's shares can be set without a new build, for trying them: a line
 * of settings.ini by the variable's own name, NFSU2_TUNE_CIRCUIT, _DRAG,
 * _DRIFT, _STREETX or _URL, with "value:share" pairs (the value's number as
 * above, the share -1..1 or "skip"), as in NFSU2_TUNE_DRIFT = 0x14:-0.6 9:0.8
 * The log says every value's range and what was set ([tune]).
 * Original: none of this. */
#include "cpu.h"
#include "guest.h"
#include "setting.h"
#include <math.h>
#include <stdio.h>
#include <string.h>

long autotest_frame(void);
void sub_0050fc60_orig(CPU *c);

#define DYNO            0x00839c40u   /* the dyno object (dyno.c) */
#define D_RECORD        0x000u        /* the car's record */
#define D_TUNED         0x900u        /* the tuning object being tuned */
#define D_VISIT         0x904u        /* the visit's copy of the 5 setups */
#define G_TUNING        0x0083a540u   /* the tuning object the tuning screens ask */
#define T_SETUP         0x14u         /* a tuning object: its setup */
#define SETUP_SZ        0x29u
#define FN_ALLOWED      0x0059b080u   /* thiscall tuning (value) -> al: the car's parts allow it */
#define FN_SCALE_A      0x005b0bd0u   /* thiscall tuning (value, point, 1) -> st0: one end of the slider's scale */
#define FN_SCALE_B      0x005b0c00u   /* ... the other (which is the lower differs: both are asked and sorted) */
#define FN_REACH_A      0x005b2bd0u   /* ... one end of what the car's parts let the slider reach (its coloured bar) */
#define FN_REACH_B      0x005b2ba0u   /* ... the other */
#define FN_CURRENT      0x005b3e40u   /* ... what the setup's byte gives */
#define V_NITROUS       0x10u
#define SKIP            9.0f

/* a share of the way to the slider's end for each kind of race: circuit, drag, drift, Street X, URL.  A first set,
 * from the usual advice (stiff and low for grip, short gearing where the corners are tight, little downforce for a
 * drag's top speed, a loose rear for a drift): to be tuned by the dyno's test runs. */
static const struct { uint8_t value; const char *name; float share[5]; } PRESETS[] = {
    { 0x00, "front springs",   {  0.5f,  0.2f,  0.3f,  0.6f,  0.5f } },
    { 0x04, "rear springs",    {  0.4f,  0.4f,  0.6f,  0.5f,  0.5f } },
    { 0x01, "front shocks",    {  0.5f,  0.2f,  0.2f,  0.6f,  0.5f } },
    { 0x05, "rear shocks",     {  0.4f,  0.4f,  0.5f,  0.5f,  0.5f } },
    { 0x02, "front sway bar",  {  0.4f,  SKIP, -0.3f,  0.3f,  0.4f } },
    { 0x06, "rear sway bar",   {  0.5f,  SKIP,  0.8f,  0.6f,  0.4f } },
    { 0x03, "front lowering",  { -0.7f, -0.5f, -0.4f, -0.7f, -0.7f } },
    { 0x07, "rear lowering",   { -0.6f, -0.3f, -0.4f, -0.7f, -0.7f } },
    { 0x08, "steering ratio",  {  0.2f, -0.5f,  0.8f,  0.6f,  0.1f } },
    { 0x09, "final drive",     {  SKIP, -0.4f,  0.7f,  0.5f, -0.15f } },
    { 0x0a, "gear 1",          {  SKIP,  SKIP,  SKIP,  SKIP,  SKIP } },
    { 0x0b, "gear 2",          {  SKIP,  SKIP,  SKIP,  SKIP,  SKIP } },
    { 0x0c, "gear 3",          {  SKIP,  SKIP,  SKIP,  SKIP,  SKIP } },
    { 0x0d, "gear 4",          {  SKIP,  SKIP,  SKIP,  SKIP,  SKIP } },
    { 0x0e, "gear 5",          {  SKIP,  SKIP,  SKIP,  SKIP,  SKIP } },
    { 0x0f, "gear 6",          {  SKIP,  SKIP,  SKIP,  SKIP,  SKIP } },
    { 0x10, "nitrous",         {  SKIP,  0.6f,  SKIP,  SKIP,  SKIP } },
    { 0x12, "brake bias",      {  0.2f,  SKIP, -0.3f,  0.1f,  0.2f } },   /* the slider: rear on its left, front on its right */
    { 0x13, "front tyre grip", {  SKIP,  SKIP,  SKIP,  SKIP,  SKIP } },
    { 0x14, "rear tyre grip",  {  SKIP,  SKIP, -0.4f,  SKIP,  SKIP } },
    { 0x15, "front downforce", {  0.6f, -1.0f,  0.6f,  1.0f,  0.5f } },
    { 0x16, "rear downforce",  {  0.7f, -0.5f, -0.6f,  1.0f,  0.6f } },
};
static const char *const KINDS[5] = { "circuit", "drag", "drift", "Street X", "URL" };
static const char *const KIND_ENV[5] = { "NFSU2_TUNE_CIRCUIT", "NFSU2_TUNE_DRAG", "NFSU2_TUNE_DRIFT", "NFSU2_TUNE_STREETX",
                                         "NFSU2_TUNE_URL" };

/* a value's share for the kind: the kind's line of settings.ini ("value:share" pairs) if it names the value, else
 * PRESETS' */
static float share_of(unsigned p, uint32_t kind){
    const char *e = getenv(KIND_ENV[kind]);
    while (e && *e){
        char *end;
        long v = strtol(e, &end, 0);
        if (end == e || *end != ':'){ e = strpbrk(e, " ,;"); if (e) e++; continue; }
        const char *val = end + 1;
        float sh = !strncasecmp(val, "skip", 4) ? SKIP : strtof(val, &end);
        if (v == (long)PRESETS[p].value) return sh == SKIP ? SKIP : sh < -1.f ? -1.f : sh > 1.f ? 1.f : sh;
        e = strpbrk(val, " ,;");
        if (e) e++;
    }
    return PRESETS[p].share[kind];
}

/* a guest function that answers in st0 (gcall puts the whole CPU back, the x87 stack with it) */
static double fcall(CPU *c, uint32_t fn, uint32_t ecx, int n, const uint32_t *arg){
    CPU save = *c;
    c->esp = (c->esp - 256u) & ~15u;
    for (int i = n - 1; i >= 0; i--) PUSH32(arg[i]);
    c->ecx = ecx;
    PUSH32(fn);
    dispatch_indirect(c, fn);
    double r = ST(0);
    *c = save;
    return r;
}

/* where a value of a setup as the game makes it stands: 100, but Street X's final drive (127) */
static uint8_t made(uint32_t v, uint32_t kind){ return kind == 3 && v == 9 ? 127 : 100; }

/* a setup as the game makes it: every byte 100, but Street X's final drive (127) and Street X's and URL's nitrous
 * (140 and 60) */
static int untouched(const uint8_t *s, uint32_t kind){
    for (uint32_t i = 0; i < SETUP_SZ; i++){
        if (s[i] == 100) continue;
        if (kind == 3 && i == 9 && s[i] == 127) continue;
        if (kind >= 3 && ((i == 0x10 && s[i] == 140) || (i == 0x11 && s[i] == 60))) continue;
        return 0;
    }
    return 1;
}

/* the preset of the kind into its setup s, by the tuning object t (whose setup is tried with, and put back) */
static int preset(CPU *c, uint32_t t, uint8_t *s, uint32_t kind){
    uint8_t was[SETUP_SZ];
    int set = 0;
    for (uint32_t i = 0; i < SETUP_SZ; i++){ was[i] = MR8(t + T_SETUP + i); MR8(t + T_SETUP + i) = s[i]; }
    for (unsigned p = 0; p < sizeof PRESETS / sizeof *PRESETS; p++){
        uint32_t v = PRESETS[p].value, arg[3] = { v, 0, 1 };
        float share = share_of(p, kind);
        if (!(gcall(c, FN_ALLOWED, t, 1, arg) & 0xffu)){
            fprintf(stderr, "[tune]   %-15s the car's parts do not allow it\n", PRESETS[p].name);
            continue;
        }
        /* a value the preset sets counts from where the game makes it, so a preset applied again does not go further */
        if (share != SKIP){
            s[v] = made(v, kind);
            if (v == V_NITROUS) s[V_NITROUS + 1u] = (uint8_t)(200 - s[v]);
            MR8(t + T_SETUP + v) = s[v];
            if (v == V_NITROUS) MR8(t + T_SETUP + V_NITROUS + 1u) = s[V_NITROUS + 1u];
        }
        /* the slider's scale (springs: 0 to 10), and inside it what this car's parts reach (a Peugeot 106's front
         * springs: pushed right as far as they go, the byte was 125 and the bar ended at 8 of 10) */
        double sa = fcall(c, FN_SCALE_A, t, 3, arg), sb = fcall(c, FN_SCALE_B, t, 3, arg);
        double ra = fcall(c, FN_REACH_A, t, 3, arg), rb = fcall(c, FN_REACH_B, t, 3, arg);
        double least = fmin(sa, sb), most = fmax(sa, sb), now = fcall(c, FN_CURRENT, t, 3, arg);
        if (isfinite(ra) && isfinite(rb) && fmax(ra, rb) > fmin(ra, rb) && fmax(fmin(ra, rb), least) < fmin(fmax(ra, rb), most)){
            least = fmax(fmin(ra, rb), least); most = fmin(fmax(ra, rb), most);
        }
        fprintf(stderr, "[tune]   %-15s scale %g .. %g, reach %g .. %g, now %g\n", PRESETS[p].name, fmin(sa, sb), fmax(sa, sb), ra, rb, now);
        if (!(most > least) || !isfinite(now)){
            fprintf(stderr, "[tune]   %-15s no range (%g .. %g)\n", PRESETS[p].name, least, most);
            continue;
        }
        if (now < least) now = least;
        if (now > most) now = most;
        if (share == SKIP){
            fprintf(stderr, "[tune]   %-15s %3u as it comes (%g of %g .. %g)\n", PRESETS[p].name, s[v], now, least, most);
            continue;
        }
        double want = share >= 0 ? now + share * (most - now) : now + share * (now - least), near = 1e30, got = now;
        double slack = (most - least) * 1e-4;
        int best = s[v];
        for (int b = 0; b <= 200; b++){
            MR8(t + T_SETUP + v) = (uint8_t)b;
            double x = fcall(c, FN_CURRENT, t, 3, arg), d = fabs(x - want);
            if (!isfinite(x) || x < least - slack || x > most + slack) continue;
            if (d < near - 1e-9 || (d < near + 1e-9 && abs(b - s[v]) < abs(best - s[v]))){ near = d; best = b; got = x; }
        }
        MR8(t + T_SETUP + v) = s[v];
        fprintf(stderr, "[tune]   %-15s %3u -> %3d (%g -> %g of %g .. %g, %+.0f %%)\n", PRESETS[p].name, s[v], best,
                now, got, least, most, share * 100.0);
        if (best != s[v]) set++;
        s[v] = (uint8_t)best;
        if (v == V_NITROUS) s[V_NITROUS + 1u] = (uint8_t)(200 - best);
        MR8(t + T_SETUP + v) = s[v];
        if (v == V_NITROUS) MR8(t + T_SETUP + V_NITROUS + 1u) = s[V_NITROUS + 1u];
    }
    for (uint32_t i = 0; i < SETUP_SZ; i++) MR8(t + T_SETUP + i) = was[i];
    return set;
}

/* 0x50FC60 (kind): the visit's copy of the kind into the setup being tuned */
void sub_0050fc60(CPU *c){
    static int on = -1;            /* 0 off, 1 untouched setups only, 2 every setup each time it opens */
    if (on < 0){
        const char *e = getenv("NFSU2_TUNE_PRESETS");
        on = e && !strcasecmp(e, "always") ? 2 : setting_bool("NFSU2_TUNE_PRESETS", 0);
    }
    uint32_t dyno = c->ecx, kind = MR32(c->esp + 4u);
    if (on && dyno == DYNO && kind < 5u && guest_rd32(DYNO + D_RECORD) && guest_ok(DYNO + D_VISIT, 5u * SETUP_SZ)){
        uint32_t t = guest_rd32(DYNO + D_TUNED), at = DYNO + D_VISIT + kind * SETUP_SZ;
        uint8_t s[SETUP_SZ];
        for (uint32_t i = 0; i < SETUP_SZ; i++) s[i] = MR8(at + i);
        if (!t || !guest_ok(t, 0x100u))
            fprintf(stderr, "[tune] f=%ld the %s setup: no tuning object (0x%08x)\n", autotest_frame(), KINDS[kind], t);
        else if (on == 2 || untouched(s, kind)){
            fprintf(stderr, "[tune] f=%ld the %s setup %s: its preset (tuning object 0x%08x, the screens' 0x%08x)\n",
                    autotest_frame(), KINDS[kind], on == 2 ? "(tune_presets = always)" : "is untouched", t,
                    guest_rd32(G_TUNING));
            int n = preset(c, t, s, kind);
            for (uint32_t i = 0; i < SETUP_SZ; i++) MR8(at + i) = s[i];
            fprintf(stderr, "[tune] %d values set\n", n);
        }
        else fprintf(stderr, "[tune] f=%ld the %s setup has values of its own: left as it is (tune_presets = always sets "
                     "it all the same)\n", autotest_frame(), KINDS[kind]);
    }
    sub_0050fc60_orig(c);
}
