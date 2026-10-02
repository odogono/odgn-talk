// Recursive passes written as generators. Each yield asks the driver to run a
// child task, so nesting depth never depends on the native call stack.
export type Task<T = void> = Generator<Task<unknown>, T, unknown>;

export const runTask = <T>(root: Task<T>): T => {
  const stack: Task<unknown>[] = [root];
  let value: unknown;
  let throwing = false;
  while (stack.length) {
    const task = stack.at(-1)!;
    try {
      const step = throwing ? task.throw(value) : task.next(value);
      throwing = false;
      if (step.done) {
        stack.pop();
        value = step.value;
      } else {
        stack.push(step.value);
        value = undefined;
      }
    } catch (error) {
      stack.pop();
      value = error;
      throwing = true;
    }
  }
  if (throwing) {
    throw value;
  }
  return value as T;
};
