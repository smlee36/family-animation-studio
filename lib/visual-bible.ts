const CHILD_PATTERN = /\b(child|kid|toddler|boy)\b|아이|아기|아들/i;
const FATHER_PATTERN = /\b(father|dad)\b|아빠/i;
const MOTHER_PATTERN = /\b(mother|mom)\b|엄마/i;
const TEDDY_PATTERN = /\b(teddy|stuffed bear|plush bear)\b|곰인형/i;

export const CHILD_SCALE_LOCK = `Fixed child scale: the son is the exact 34-month-old Korean toddler from the Master References, 93 cm tall, with a clearly toddler-sized body of about 4.5 head-lengths, a large toddler head, narrow shoulders, short limbs, and small hands and feet. When standing together, he is about 53% of the 174 cm father's height and 58% of the 161 cm mother's height. Keep this same age and physical scale when he is sitting or lying down.`;

export const TEDDY_SCALE_LOCK = `Fixed teddy scale: the brown teddy is the one oversized floor plush from the Master References, approximately 60 cm high when seated and 70 cm from head to feet when lying down, about 65-75% of the child's 93 cm height. Its broad torso is large enough for the toddler to rest his head and chest on and wrap both arms around. Keep exactly one teddy with this same large scale, shape, face, colors, and markings.`;

export const PARENT_SCALE_LOCK = `Fixed parent scale: the Korean father is 174 cm tall and the Korean mother is 161 cm tall, with the exact adult body proportions in their Master References.`;

export function familyScaleLock(context: string) {
  const rules: string[] = [];
  if (CHILD_PATTERN.test(context)) rules.push(CHILD_SCALE_LOCK);
  if (FATHER_PATTERN.test(context) || MOTHER_PATTERN.test(context)) rules.push(PARENT_SCALE_LOCK);
  if (TEDDY_PATTERN.test(context)) rules.push(TEDDY_SCALE_LOCK);
  if (!rules.length) return "";
  return `\nRelative-size lock: ${rules.join(" ")} Preserve these physical ratios under perspective and across every frame; camera distance may change, physical sizes do not.`;
}

export function referenceScaleHint(category: string) {
  if (category === "아이") return CHILD_SCALE_LOCK;
  if (category === "아빠" || category === "엄마") return PARENT_SCALE_LOCK;
  if (category === "곰인형") return TEDDY_SCALE_LOCK;
  return "";
}
