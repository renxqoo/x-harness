export async function settle() {
  for (let index = 0; index < 128; index++) await Promise.resolve();
}
