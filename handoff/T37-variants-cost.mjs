const G = ["pd < 1.0 + phGradLen * 13.0 && alt < topHere", "(band > 0.01 || cb > 0.45) && alt < topHere"];
const P = ["float phC = 6.0 * atan(hc.y, hc.x) - 18.5 * log(max(rcc, 1.0));", "float phC = phB;"];
const A = ["if (Ht > 9.5 && alt > 7.0) {", "if (false) {"];
const T = ["float sd = bandTowerSdf(xz, alt, c, Ht, Rt, h3);", "float sd = length(vec2(rho / Rt, max(alt - Ht, 0.0))) * Rt - Rt;"];
export const VARIANTS = [["base", []], ["gate", [G]], ["phase", [P]], ["noanv", [A]], ["simpletower", [T]], ["base2", []]];
