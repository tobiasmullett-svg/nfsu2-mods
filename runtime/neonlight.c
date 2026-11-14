/* neonlight.c -- the player's underglow colour, for the page: a DualSense's lightbar shows it (web/src/input/
 * dualsense.ts, through the game's status "car_neon" of runtime/web/status_web.c).
 *
 * A ride's parts are at RideInfo +0x590, a CarPart pointer for each of its 170 slots.  The underglow is slot 154,
 * NEON: the slots' names stand in the game in their order, from 0x7A72B4 MISC (169) back to BASE, and there 154 is
 * NEON, 155 NEON_ENGINE, 156 NEON_CABIN, 157 NEON_TRUNK and 158 CABIN_NEON_FRAME (specialties.c's 34 TRUNK_AUDIO and
 * 163-166 CUSTOM_HUD and its colours are the same list).  Its parts are the Car Specialties shop's neon colours, kind
 * 54 (CarPart +4): NO NEON, RED, GREEN, BLUE, YELLOW, AQUA, WHITE, CORAL, MAGENTA, LIME, PURPLE, GOLD and a PULSE of
 * each, their colour in the attributes RED, GREEN and BLUE, 0 to 255, as GLOBALB's car part database has them (RED
 * 128, 0, 0; PURPLE 72, 31, 80; GOLD 255, 150, 0; NO NEON 0, 0, 0).  A mod's neon colour reads the same way.
 * The car: the player's while the world runs (GameFlow 6), else the front end's ride (3: the garage and the shops,
 * so the lightbar follows the neon while it is picked).  Its colour is read with the game's attribute lookup
 * (0x61B500) when the slot's part changes, not every frame.
 * neonlight_rgb(): -1 no car (or no neon part in the slot), else 0xRRGGBB, plus NEON_PULSE for a PULSE. */
#include "cpu.h"
#include "guest.h"
#include "game.h"
#include "featurelist.h"
#include <stdio.h>
#include <string.h>

#define SLOT_NEON      154u          /* the ride's slot NEON: the underglow */
#define KIND_NEON      54u           /* CarPart +4 of a neon colour */
#define CP_KIND        4u
#define CP_SIZE        14u           /* a CarPart's bytes (vinylpacks.c) */
#define A_RED          0x0000d99au   /* bStringHash("RED") */
#define A_GREEN        0x02ddc8f0u   /* bStringHash("GREEN") */
#define A_BLUE         0x00136707u   /* bStringHash("BLUE") */
#define NEON_PULSE     0x1000000

static int g_rgb = -1;
static uint32_t g_part = 1u;         /* the part g_rgb was read from (1: none read yet) */

int neonlight_rgb(void){ return g_rgb; }

/* the ride whose underglow shows, 0: none */
static uint32_t ride_now(void){
    uint32_t flow = guest_rd32(G_FLOW);
    if (flow == 6u) return guest_rd32(guest_rd32(guest_rd32(SPLIT_PLAYERS_INDEX) + 4u) + CAR_RIDE);   /* player 1: +4 its car */
    return flow == 3u ? G_FE_RIDE : 0u;
}

static uint32_t attr(CPU *c, uint32_t part, uint32_t hash){
    uint32_t a[2] = { hash, 0 }, v = gcall_main(c, FN_PART_ATTR, part, 2, a);
    return v > 255u ? 255u : v;
}

void neonlight_frame(CPU *c){
    uint32_t ride = ride_now(), at = ride + RIDE_PARTS + 4u * SLOT_NEON;
    uint32_t part = ride && guest_ok_bytes(at, 4u) ? MR32(at) : 0u;
    if (part == g_part) return;
    g_part = part;
    int was = g_rgb;
    if (!part || !guest_ok_bytes(part, CP_SIZE) || MR8(part + CP_KIND) != KIND_NEON){
        g_rgb = -1;
        if (was != g_rgb && part) fprintf(stderr, "[neon] slot %u holds a part of kind %u, not a neon colour\n", SLOT_NEON,
                                          guest_ok_bytes(part, CP_SIZE) ? MR8(part + CP_KIND) : 0u);
        return;
    }
    uint32_t r = attr(c, part, A_RED), g = attr(c, part, A_GREEN), b = attr(c, part, A_BLUE);
    char name[40];
    guest_read_str(gcall_main(c, FN_PART_NAME, part, 0, 0), name, (int)sizeof name);
    g_rgb = (int)(r << 16 | g << 8 | b) + (strstr(name, "PULSE") ? NEON_PULSE : 0);
    if (g_rgb != was) fprintf(stderr, "[neon] underglow %s: %u, %u, %u\n", name[0] ? name : "?", r, g, b);
}
