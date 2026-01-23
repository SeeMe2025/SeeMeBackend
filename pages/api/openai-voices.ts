import type { NextApiRequest, NextApiResponse } from 'next'

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const voices = [
    { voice_id: "echo", name: "Adam", gender: "Male", style: "American, Middle age", description: "Clear and confident, great for coaching", headshot_image: "Adam" },
    { voice_id: "nova", name: "Beth", gender: "Female", style: "American, Young", description: "Warm and friendly, perfect for guidance", headshot_image: "Beth" },
    { voice_id: "sage", name: "Mo", gender: "Male", style: "British, Mature", description: "Wise and thoughtful, insightful guidance", headshot_image: "Mo" },
    { voice_id: "shimmer", name: "Marianna", gender: "Female", style: "American, Young", description: "Bright and optimistic, uplifting presence", headshot_image: "Marianna" },
    { voice_id: "onyx", name: "Brian", gender: "Male", style: "American, Middle age", description: "Deep and authoritative, great for motivation", headshot_image: "Brian" },
    { voice_id: "coral", name: "Charlotte", gender: "Female", style: "British, Middle age", description: "Warm and engaging, supportive companion", headshot_image: "Charlotte" }
  ]

  res.status(200).json({ voices })
}
