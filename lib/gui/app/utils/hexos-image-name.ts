/*
 * Pretty display name for HexOS installer images.
 *
 * HexOS ISOs are named `TrueNAS-SCALE-<version>-HexOS.iso` (e.g.
 * TrueNAS-SCALE-25.10.3-HexOS.iso); show them as "HexOS <version>".
 * Anything else passes through untouched.
 */

const HEXOS_ISO_NAME = /^TrueNAS-SCALE-([\d.]+)-HexOS\.iso$/i;

export function prettyHexOSImageName(name: string): string {
	const match = HEXOS_ISO_NAME.exec(name);
	return match ? `HexOS ${match[1]}` : name;
}
