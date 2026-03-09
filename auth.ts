import NextAuth from "next-auth"
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id"
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// Schema-qualified client for staff schema
const staffDb = supabase.schema('staff')

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    MicrosoftEntraID({
      clientId: process.env.AZURE_AD_CLIENT_ID!,
      clientSecret: process.env.AZURE_AD_CLIENT_SECRET!,
      issuer: `https://login.microsoftonline.com/${process.env.AZURE_AD_TENANT_ID}/v2.0`,
      authorization: {
        params: {
          scope: "openid profile email User.Read"
        }
      }
    })
  ],
  callbacks: {
    async signIn({ user }) {
      if (!user.email) return false

      const emailDomain = user.email.split('@')[1]
      const allowedDomains = ['easylemon.com', 'rockpointgrowth.com']
      if (!allowedDomains.includes(emailDomain)) return false

      try {
        // Query staff.staff_users (correct schema)
        const { data: staffUser, error } = await staffDb
          .from('staff_users')
          .select('id, email, active')
          .eq('email', user.email)
          .single()

        if (error && error.code !== 'PGRST116') {
          // PGRST116 = no rows found — expected for new users
          console.error('staff_users lookup error:', error)
        }

        if (!staffUser) {
          // New user — create record in staff.staff_users
          const { error: insertError } = await staffDb
            .from('staff_users')
            .insert({
              email: user.email,
              role: user.email === 'novaj@rockpointgrowth.com' ? 'admin' : 'staff',
              active: true
            })

          if (insertError) {
            console.error('staff_users insert error:', insertError)
          }
        }

        return true
      } catch (error) {
        console.error('signIn error:', error)
        return true // Allow sign in even if DB write fails
      }
    },

    async session({ session }) {
      if (!session.user?.email) return session

      try {
        const { data: staffUser } = await staffDb
          .from('staff_users')
          .select('role, active')
          .eq('email', session.user.email)
          .single()

        if (staffUser) {
          session.user.role = staffUser.role
          session.user.active = staffUser.active
        }
      } catch (error) {
        console.error('session callback error:', error)
      }

      return session
    }
  },
  pages: {
    signIn: '/login',
  }
})
