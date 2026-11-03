export function price(amount: number): number {
    return amount * 1.2;
}

export const CURRENCY = 'EUR';

export function label(name: string): string {
    return name.trim();
}

export const VERSION = 1;

export const TAGLINE = 'fast, no bugs';

export const NAME = 'conflate';

export function legacy(): void {
    console.log('legacy');
}

export const END = true;
